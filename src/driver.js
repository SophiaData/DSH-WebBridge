import { chromium } from 'playwright-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeError } from './envelope.js'
import { buildFingerprintScript, buildUaMetadata, buildUserAgent, defaultFingerprint } from './browser-fingerprint.js'
import { BrowserDiagnostics, diagnosticText, diagnosticUrl } from './browser-diagnostics.js'

const DEFAULT_SESSION = '__webbridge_default__'
const STOP_SELECTOR = 'button[data-testid="stop-button"],button[aria-label="停止"],button[aria-label="停止生成"],button[aria-label="停止流式传输"],button[aria-label="Stop"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ChatGPT renders replies in a React virtualized list. Between resolving a
// locator to a handle and acting on it, the node can be torn down and
// re-rendered, which Playwright surfaces as a bare `Error`, not a
// TimeoutError, e.g. "Element is not attached to the DOM". Such races are
// transient and safe to retry; anything else must still propagate. Closed
// pages/contexts and aborts are explicitly excluded so they keep their own
// semantics and never get mistaken for a re-render.
const ROWS_RERENDERED = /Element is not attached to the DOM|JSHandle is disposed|Execution context was destroyed|Cannot find context|frame (?:was|got) detached/i
function rowsRerendered(error) {
  if (!error) return false
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return false
  const message = String(error.message || '')
  if (/Target (?:page|context|browser).*closed|has been closed/i.test(message)) return false
  return ROWS_RERENDERED.test(message)
}

export function detectChromeVersion(executablePath, fallback = '') {
  const directories = [dirname(executablePath)]
  if (process.platform === 'darwin') directories.push(join(dirname(executablePath), '..', 'Frameworks', 'Google Chrome Framework.framework', 'Versions'))
  for (const directory of directories) {
    try {
      const versions = readdirSync(directory).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      if (versions.length) return versions[0]
    } catch {}
  }
  return fallback
}

/**
 * WebBridge-owned persistent browser runtime. A single Chrome Context holds
 * independent Pages; AsyncLocalStorage routes every command to its DSH session.
 * Session queues are isolated, so one session never serializes another.
 */
export class BrowserDriver {
  constructor(settings, log = () => {}) {
    this.settings = settings
    this.log = log
    this.storage = new AsyncLocalStorage()
    this.queues = new Map()
    this.pages = new Map()
    this.sessionPages = new Map()
    this.sessions = new Map()
    this.context = null
    this.contextPromise = null
    this.registryLoaded = false
    this.registryWrites = Promise.resolve()
    this.stateDir = settings.stateDir || join(homedir(), '.dsh', 'webbridge')
    this.registryPath = join(this.stateDir, 'sessions.json')
    this.modePath = join(this.stateDir, 'browser-mode.json')
    this.debugMode = Boolean(settings.debugMode)
    this.active = 0
    this.lastMode = null
    this.modeChangePending = false
    this.modeChangePromise = null
    this.generations = new Map()
    this.activities = new Map()
    this.diagnostics = new BrowserDiagnostics((kind, entry) => {
      if (kind !== 'network' || !['fetch', 'xhr'].includes(entry.resourceType)) return
      const conversation = /\/backend-api\/(?:f\/)?conversation(?:\/|\?|$)/.test(entry.url)
      if (!conversation) return
      const key = [...this.sessionPages].find(([, pageId]) => pageId === entry.pageId)?.[0]
      this.activities.get(key)?.emit(entry.ok ? 'network.response' : 'network.failed',
        entry.ok ? '收到网页接口响应' : '网页接口请求中断或失败', {
          pageId: entry.pageId, method: entry.method, url: entry.url,
          status: entry.status, code: entry.failed, durationMs: entry.durationMs,
        })
    })
  }

  get busy() { return this.active > 0 }
  get available() { return Boolean(this.executablePath) }
  get profileDir() { return this.settings.browserProfileDir || join(homedir(), '.dsh', 'webbridge', 'chrome-profile') }
  get headless() { return this.context && this.lastMode ? !this.lastMode.headed : !this.debugMode }

  get executablePath() {
    const explicit = this.settings.browserExecutablePath || process.env.CHROME_PATH
    if (explicit && existsSync(explicit)) return explicit
    const candidates = process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    return candidates.find(path => path && existsSync(path))
  }

  async loadRegistry() {
    if (this.registryLoaded) return
    this.registryLoaded = true
    try {
      const saved = JSON.parse(await readFile(this.registryPath, 'utf8'))
      for (const [key, value] of Object.entries(saved.sessions || {})) {
        if (!value || typeof value !== 'object') continue
        this.sessions.set(key, { ...value })
        if (value.pageId) this.sessionPages.set(key, value.pageId)
      }
    } catch (error) { if (error.code !== 'ENOENT') this.log(`[webbridge] session registry read failed: ${error.message}`) }
    try {
      const mode = JSON.parse(await readFile(this.modePath, 'utf8'))
      this.debugMode = mode.debugMode === true
    } catch {}
  }

  async persistRegistry() {
    const snapshot = { version: 1, updatedAt: new Date().toISOString(), sessions: Object.fromEntries(this.sessions) }
    this.registryWrites = this.registryWrites.then(async () => {
      await mkdir(this.stateDir, { recursive: true })
      const tmp = this.registryPath + '.tmp'
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
      await rm(this.registryPath, { force: true })
      const { rename } = await import('node:fs/promises')
      await rename(tmp, this.registryPath)
    }).catch(error => this.log(`[webbridge] session registry write failed: ${error.message}`))
    return this.registryWrites
  }

  async setDebugMode(enabled) {
    await this.loadRegistry()
    this.debugMode = Boolean(enabled)
    await mkdir(this.stateDir, { recursive: true })
    await writeFile(this.modePath, JSON.stringify({ debugMode: this.debugMode, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    const hasRuntime = Boolean(this.context || this.contextPromise)
    const runtimeMatches = !this.contextPromise && this.lastMode?.headed === this.debugMode
    this.modeChangePending = hasRuntime && !runtimeMatches
    if (this.modeChangePending && !this.busy && !this.generations.size) await this.flushModeChange()
    // The next browser task applies the mode; saved conversations stay closed.
    return { debugMode: this.debugMode, headless: this.headless, restarted: false, pending: this.modeChangePending }
  }

  /**
   * Deploy the bundled WebAgent extension to a stable path once (see
   * docs/WEBAGENT-EXTENSION.md). The folder must never move afterwards,
   * because chrome://extensions keeps pointing at the install path.
   */
  async ensureBundledExtension() {
    try {
      const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'third_party', 'webagent')
      if (!existsSync(join(source, 'manifest.json'))) return
      const target = join(this.stateDir, 'webagent-extension')
      if (existsSync(join(target, 'manifest.json'))) return
      cpSync(source, target, { recursive: true })
      this.log(`[webbridge] bundled WebAgent extension deployed to ${target}`)
    } catch (error) {
      this.log(`[webbridge] extension deploy failed: ${error.message}`)
    }
  }

  async ensureContext(forceHeaded = false) {
    if (this.disposed) throw new BridgeError('browser-closed', '浏览器已停止。')
    await this.loadRegistry()
    if (this.context && this.context.browser()?.isConnected()) return this.context
    if (this.contextPromise) return this.contextPromise
    this.contextPromise = (async () => {
      await mkdir(this.profileDir, { recursive: true })
      await this.ensureBundledExtension()
      const executablePath = this.executablePath
      if (!executablePath) throw new BridgeError('chrome-not-found', '找不到 Chrome，请安装 Google Chrome 或设置 browserExecutablePath。')
      const fingerprint = this.settings.fingerprint || defaultFingerprint()
      const version = detectChromeVersion(executablePath, this.settings.chromeVersion || '157.0.8103.52')
      const userAgent = this.settings.userAgent || buildUserAgent(version)
      const locale = this.settings.locale || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
      const timezone = this.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
      const args = [
        '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
        '--disable-infobars', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      ]
      // Branded Google Chrome >= 136 ignores --load-extension, so there the
      // extension only runs after the one-time manual install described in
      // docs/WEBAGENT-EXTENSION.md. Chromium/Edge builds still honour these
      // switches, which makes the same bundle zero-touch on them. On Chrome
      // the switches are simply ignored.
      const extensionDir = join(this.stateDir, 'webagent-extension')
      if (existsSync(join(extensionDir, 'manifest.json'))) {
        args.push(`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`)
      }
      const headed = forceHeaded || this.debugMode
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: !headed, executablePath, viewport: { width: 1440, height: 900 },
        acceptDownloads: true, locale, ...(timezone ? { timezoneId: timezone } : {}),
        ignoreHTTPSErrors: true, args,
        // Playwright passes --disable-extensions by default, which would also
        // kill the extension installed into this WebBridge-owned profile.
        // Drop only that one switch; nothing else in this profile depends on it.
        ignoreDefaultArgs: ['--disable-extensions'],
      })
      const context = this.context
      const applyUa = async page => {
        try {
          const cdp = await context.newCDPSession(page)
          await cdp.send('Emulation.setUserAgentOverride', { userAgent, userAgentMetadata: buildUaMetadata(version) })
        } catch {}
      }
      const watch = page => this.diagnostics.watch(page, () => [...this.pages].find(([, value]) => value === page)?.[0] || '')
      for (const page of context.pages()) { watch(page); await applyUa(page) }
      context.on('page', page => { watch(page); applyUa(page).catch(() => {}) })
      await context.addInitScript(buildFingerprintScript(fingerprint, userAgent, locale))
      context.on('close', () => { if (this.context === context) this.context = null })
      this.lastMode = { headed, at: Date.now() }
      this.log(`[webbridge] native Chrome started mode=${headed ? 'headed' : 'headless'} profile=${this.profileDir}`)
      return context
    })().finally(() => { this.contextPromise = null })
    return this.contextPromise
  }

  async restoreSessions() {
    await this.loadRegistry()
    return { restored: 0, saved: this.sessions.size }
  }

  async getPageFor(sessionKey = DEFAULT_SESSION) {
    const context = await this.ensureContext()
    let pageId = this.sessionPages.get(sessionKey)
    let page = pageId ? this.pages.get(pageId) : null
    if (page && !page.isClosed()) { this.lastPageId = pageId; return page }
    page = context.pages().find(candidate => !candidate.isClosed() && candidate.url() === 'about:blank' && ![...this.pages.values()].includes(candidate)) || await context.newPage()
    pageId = `wb-${createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 20)}`
    this.pages.set(pageId, page)
    this.lastPageId = pageId
    this.sessionPages.set(sessionKey, pageId)
    const old = this.sessions.get(sessionKey) || {}
    this.sessions.set(sessionKey, { ...old, pageId, createdAt: old.createdAt || new Date().toISOString() })
    const savedUrl = old.url
    if (savedUrl && savedUrl !== 'about:blank') {
      await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(error => this.log(`[webbridge] restore ${sessionKey} failed: ${error.message}`))
    }
    page.on('close', () => { this.pages.delete(pageId) })
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        const watchId = this.generations.get(sessionKey)
        if (watchId) this.installGenerationWatch(page, watchId).catch(() => {})
        const meta = this.sessions.get(sessionKey) || {}
        this.sessions.set(sessionKey, { ...meta, pageId, url: page.url(), updatedAt: new Date().toISOString() })
        this.persistRegistry().catch(() => {})
      }
    })
    await this.persistRegistry()
    return page
  }

  async releasePage(sessionKey = this.currentKey()) {
    const pageId = this.sessionPages.get(sessionKey)
    const page = this.pages.get(pageId)
    if (!page || page.isClosed()) return
    await this.persistRegistry()
    await page.close().catch(error => this.log(`[webbridge] closing task page failed: ${error.message}`))
    this.pages.delete(pageId)
  }

  currentKey() { return this.storage.getStore() || DEFAULT_SESSION }
  async getSessionInfo(key) { await this.loadRegistry(); const value = this.sessions.get(String(key)); return value ? { ...value } : null }
  async updateSessionInfo(key, patch = {}) {
    await this.loadRegistry()
    const current = this.sessions.get(String(key)) || {}
    this.sessions.set(String(key), { ...current, ...patch, pageId: this.sessionPages.get(String(key)) || current.pageId, updatedAt: new Date().toISOString() })
    await this.persistRegistry()
  }
  async currentPage() { return this.getPageFor(this.currentKey()) }

  replyPageGuard() {
    const pageId = this.sessionPages.get(this.currentKey())
    const page = this.pages.get(pageId)
    const context = this.context
    return () => {
      if (this.disposed || !context || this.context !== context || !page || page.isClosed()
        || this.pages.get(pageId) !== page || !context.browser()?.isConnected()) {
        throw new BridgeError('browser-closed', '网页会话已关闭，或插件已重新加载。本轮等待已结束，请从当前 DSH 会话重试。')
      }
    }
  }

  /** Use real wheel input in the conversation area to reveal the latest reply. */
  async scrollToBottom({ signal } = {}) {
    if (signal?.aborted) throw new BridgeError('aborted', '回复滚动已取消。')
    const guard = this.replyPageGuard()
    guard()
    const page = await this.currentPage()
    const state = await this.state(page)
    if (state.manualAuth?.required) throw new BridgeError(`auth-required:${state.manualAuth.kind}`, '请先在网页完成登录或验证，再重试。')
    this.activities.get(this.currentKey())?.emit('reply.scrolling-bottom', '正在将对话滚动到最底部，监听最新回复元素')
    const viewport = page.viewportSize() || { width: 1440, height: 900 }
    await page.mouse.move(viewport.width * 0.7, viewport.height * 0.4)
    await page.mouse.wheel(0, 100000)
    if (signal?.aborted) throw new BridgeError('aborted', '回复滚动已取消。')
    guard()
  }

  /** Restore the owned reply surface without submitting another message. */
  async reconnectReply({ turnKey, url, signal }) {
    const guard = this.replyPageGuard()
    const check = () => {
      if (signal?.aborted) throw new BridgeError('aborted', '回复恢复已取消。')
      guard()
    }
    check()
    const page = await this.currentPage()
    const authorize = async () => {
      check()
      const state = await this.state(page)
      if (state.manualAuth?.required) throw new BridgeError(`auth-required:${state.manualAuth.kind}`, '请先在网页完成登录或验证，再重试。')
    }
    await authorize()
    const activity = this.activities.get(this.currentKey())
    const target = page.locator(`[data-content-search-unit-key^=${JSON.stringify(turnKey + ':')}]`).filter({ visible: true }).last()
    const command = { signal, timeout: Math.min(2500, this.settings.commandTimeoutMs || 2500) }
    const scrollAndFind = async () => {
      check()
      try {
        await this.scrollToBottom({ signal })
      } catch (error) {
        check()
        if (!rowsRerendered(error)) throw error
      }
      // Bound retries: each waitFor re-resolves the locator to a fresh handle,
      // so a node that React re-rendered between resolve and scroll gets picked
      // up again. A TimeoutError still means "not found" and falls straight
      // through to the reopen path, preserving the original cadence.
      for (let attempt = 0; attempt < 3; attempt++) {
        check()
        try {
          await target.waitFor({ ...command, state: 'visible' })
          await target.scrollIntoViewIfNeeded({ ...command, timeout: Math.max(300, Math.min(1200, command.timeout)) })
          check()
          return true
        } catch (error) {
          check()
          if (error.name === 'TimeoutError') return false
          if (!rowsRerendered(error)) throw error
          if (attempt === 2) return false
          await sleep(120 + attempt * 200)
          check()
        }
      }
      return false
    }
    if (await scrollAndFind()) return { found: true, reloaded: false }
    activity?.emit('reply.reloading', '滚动后仍未找到本轮元素，正在重新打开原网页会话')
    await this.open(url, { signal, timeoutMs: Math.min(10000, this.settings.commandTimeoutMs || 10000) })
    await authorize()
    return { found: await scrollAndFind(), reloaded: true }
  }

  exclusive(operation, sessionKey = DEFAULT_SESSION) {
    const key = String(sessionKey || DEFAULT_SESSION)
    const previous = this.queues.get(key) || Promise.resolve()
    const execute = async () => {
      if (this.modeChangePromise) await this.modeChangePromise
      this.active++
      try { return await this.storage.run(key, operation) }
      finally {
        this.active--
        if (!this.active && this.modeChangePending) await this.flushModeChange()
      }
    }
    const run = previous.then(execute, execute)
    this.queues.set(key, run.catch(() => {}))
    return run
  }

  async run(command, positional = [], options = {}) {
    if (command === 'status') return { ok: true, running: Boolean(this.context), profile: 'webbridge', health: 'native-playwright', pages: this.pages.size, headless: this.headless }
    const page = await this.currentPage()
    const timeout = options.timeoutMs ?? this.settings.commandTimeoutMs ?? 60000
    const selector = String(positional[0] || '')
    switch (command) {
      case 'state': return { ok: true, ...(await this.state()) }
      case 'query': {
        const items = await page.locator(selector).evaluateAll(nodes => nodes.map(el => {
          const r = el.getBoundingClientRect()
          return { text: (el.innerText || el.textContent || '').slice(0, 500), rect: { x:r.x,y:r.y,width:r.width,height:r.height }, tag: el.tagName, visible: !!(r.width && r.height) }
        }))
        return { ok: true, items }
      }
      case 'wait': await page.locator(selector).waitFor({ state: 'visible', timeout }); return { ok: true }
      case 'select': await page.locator(selector).selectOption(positional[1], { timeout }); return { ok: true }
      case 'screenshot': {
        const path = join(this.stateDir, 'screenshots', `webbridge-${Date.now()}.png`)
        await mkdir(join(this.stateDir, 'screenshots'), { recursive: true })
        await page.screenshot({ path, fullPage: false })
        return { ok: true, path }
      }
      case 'upload': {
        const files = positional.slice(1)
        await page.locator(selector).last().setInputFiles(files, { timeout })
        return { ok: true, files: files.length }
      }
      default: throw new BridgeError('unsupported-command', `不支持的浏览器命令：${command}`)
    }
  }

  async state(page) {
    page ||= await this.currentPage()
    const url = page.url()
    const title = await page.title().catch(() => '')
    const parsedUrl = new URL(url || 'about:blank')
    const authUrl = parsedUrl.hostname.toLowerCase() === 'auth.openai.com' || ['/login', '/signin', '/sign-in', '/auth'].some(part => parsedUrl.pathname.toLowerCase().startsWith(part))
    const controls = await page.evaluate(() => {
      const visible = node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      const buttons = [...document.querySelectorAll('button,a')].filter(visible)
      const signedIn = buttons.some(node => /^(打开个人资料菜单|Open profile menu)$/i.test(node.getAttribute('aria-label') || '') || node.getAttribute('data-testid') === 'accounts-profile-button')
        || location.hostname === 'platform.openai.com' && buttons.some(node => /^(Create new secret key|Create tunnel|创建新密钥|创建隧道)$/i.test((node.innerText || '').trim()))
      const login = buttons.some(node => /^(登录|Log in|Sign in)$/.test((node.innerText || '').trim()))
      const password = [...document.querySelectorAll('input[type="password"]')].some(visible)
      const challenge = [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenges.cloudflare.com"],#challenge-running,#challenge-stage,[data-testid="captcha"]')].some(visible)
        || !signedIn && [...document.querySelectorAll('h1,h2')].filter(visible).some(node => /verify you are human|人机验证|访问验证|Just a moment/i.test(node.textContent || ''))
      return { signedIn, login, password, challenge }
    }).catch(() => ({ signedIn: false }))
    const challenge = Boolean(controls.challenge)
    const loginRequired = Boolean(authUrl || challenge || controls.password || controls.login && !controls.signedIn)
    const manualAuth = { required: loginRequired, kind: challenge ? 'verification' : 'login', reasons: loginRequired ? [challenge ? 'verification-page' : authUrl ? 'login-url' : 'login-control'] : [] }
    const result = { url, title, headless: !this.lastMode?.headed, authenticated: Boolean(controls.signedIn && !loginRequired), manualAuth }
    return result
  }

  async open(url, options = {}) {
    const page = await this.currentPage()
    if (options.headed && !this.debugMode && this.lastMode?.headed !== true) {
      if (this.active > 1 || this.generations.size) throw new BridgeError('browser-busy', '其他会话仍在生成，请等待结束后再打开登录窗口。')
      // Login is the only operation allowed to request a temporary visible browser.
      const current = page.url()
      await this.closeContext()
      await this.ensureContext(true)
      const headedPage = await this.currentPage()
      if (current && current !== 'about:blank') await headedPage.goto(current, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
      return this.open(url, { ...options, headed: false })
    }
    const response = await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: options.timeoutMs || 45000, signal: options.signal })
    return { url: page.url(), status: response?.status() ?? null }
  }

  async click(selector, options = {}) { const page = await this.currentPage(); await page.locator(selector).filter({ visible: true }).first().click({ timeout: options.timeoutMs || 20000 }); return { ok: true } }
  async fill(selector, value, options = {}) { const page = await this.currentPage(); const loc = page.locator(selector).filter({ visible: true }).first(); if (options.append) await loc.pressSequentially(String(value), { timeout: options.timeoutMs || 30000 }); else await loc.fill(String(value), { timeout: options.timeoutMs || 30000 }); return { ok: true } }
  async fillLong(selector, value, options = {}) { return this.fill(selector, value, options) }
  async press(key, options = {}) { const page = await this.currentPage(); await page.keyboard.press(String(key), { timeout: options.timeoutMs || 10000 }); return { ok: true } }
  async eval(expression, options = {}) { const page = await this.currentPage(); const result = await page.evaluate(String(expression)); return { result } }
  async inspect(action, options = {}) {
    const pages = [...this.pages].filter(([, page]) => !page.isClosed()).map(([pageId, page]) => ({ pageId, url: diagnosticUrl(page.url()), current: pageId === this.lastPageId }))
    if (options.pageId && !pages.some(page => page.pageId === options.pageId)) throw new BridgeError('page-not-found', '调试页面已关闭，请刷新页面列表。')
    const common = { running: Boolean(this.context), pages }
    if (action === 'pages') return common
    if (['console', 'network'].includes(action)) return { ...common, ...this.diagnostics.read(action, options) }
    if (action !== 'debug') throw new BridgeError('unknown-action', '未知的浏览器调试操作。')
    const pageId = options.pageId || this.lastPageId
    const page = this.pages.get(pageId)
    const result = { ...common, console: this.diagnostics.read('console', options), network: this.diagnostics.read('network', options), dialogs: this.diagnostics.read('dialogs', options) }
    if (!page || page.isClosed()) return result
    result.state = { ...(await this.state(page)), url: diagnosticUrl(page.url()), pageId }
    try {
      const path = join(this.stateDir, 'screenshots', `debug-${Date.now()}.png`)
      await mkdir(dirname(path), { recursive: true })
      await page.screenshot({ path, timeout: 10000 })
      result.screenshot = { path }
    } catch (error) { result.screenshot = { error: diagnosticText(error.message) } }
    return result
  }
  async attachTextFile(name, content) {
    const page = await this.currentPage()
    const payload = { name: basename(String(name)), content: String(content).slice(0, 20000) }
    const result = await page.evaluate(({ name, content }) => {
      const input = [...document.querySelectorAll('input[type="file"]')].at(-1)
      if (!input) return { ok: false, reason: 'no-file-input' }
      const dt = new DataTransfer()
      dt.items.add(new File([content], name, { type: 'text/plain' }))
      input.files = dt.files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, files: input.files.length }
    }, payload)
    return result
  }
  async attachFiles(files, options = {}) {
    const root = join(this.stateDir, 'uploads')
    await mkdir(root, { recursive: true })
    const temporary = await import('node:fs/promises').then(fs => fs.mkdtemp(join(root, 'webbridge-')))
    try {
      const paths = []
      for (const [i, file] of files.entries()) {
        const dir = join(temporary, String(i)); await mkdir(dir)
        const name = basename(String(file.name || `attachment-${i + 1}`)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        const path = join(dir, name)
        if (file.path) await copyFile(file.path, path)
        else if (typeof file.content === 'string') await writeFile(path, file.content, { mode: 0o600 })
        else throw new BridgeError('attachment-unavailable', `无法读取附件 ${name}`)
        paths.push(path)
      }
      await this.run('upload', ['input[type="file"]', ...paths], { timeoutMs: options.timeoutMs || 60000, signal: options.signal })
      return { ok: true, release: () => rm(temporary, { recursive: true, force: true }) }
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
  }
  async prepareUploads() {}
  async composerBlank(inputSelector) { const page = await this.currentPage(); return await page.locator(inputSelector).evaluateAll(nodes => nodes.length > 0 && nodes.every(el => !(el.value ?? el.textContent ?? '').trim())) }
  async startGenerationWatch(id) {
    this.generations.set(this.currentKey(), id)
    await this.installGenerationWatch(await this.currentPage(), id)
  }
  async installGenerationWatch(page, id) {
    await page.evaluate(`(() => {
      if (window.__webbridgeGenerationWatch?.id === ${JSON.stringify(id)} && window.__webbridgeGenerationWatch.active && window.__webbridgeStopListener) return true;
      if (window.__webbridgeStopListener) document.removeEventListener('click', window.__webbridgeStopListener, true);
      const watch = window.__webbridgeGenerationWatch = { id: ${JSON.stringify(id)}, active: true, stopped: false };
      window.__webbridgeStopListener = event => {
        if (event.isTrusted && watch.active && event.target?.closest?.(${JSON.stringify(STOP_SELECTOR)})) watch.stopped = true;
      };
      document.addEventListener('click', window.__webbridgeStopListener, true);
      return true;
    })()`)
  }
  async stopGeneration(id) {
    const page = await this.currentPage()
    const own = this.generations.get(this.currentKey()) === id || await page.evaluate(id => Boolean(window.__webbridgeGenerationWatch?.active && window.__webbridgeGenerationWatch.id === id), id)
    if (own) {
      const button = page.locator(STOP_SELECTOR).filter({ visible: true }).first()
      if (await button.count()) {
        await button.click()
        await button.waitFor({ state: 'hidden', timeout: 10000 })
      }
    }
  }
  async endGenerationWatch(id) {
    try { await this.eval(`(() => {
      if(window.__webbridgeGenerationWatch?.id === ${JSON.stringify(id)}) {
        window.__webbridgeGenerationWatch.active = false;
        if (window.__webbridgeStopListener) document.removeEventListener('click', window.__webbridgeStopListener, true);
      }
      return true;
    })()`) } finally { if (this.generations.get(this.currentKey()) === id) this.generations.delete(this.currentKey()) }
  }
  async waitLogin(timeoutMs, options = {}) { const end = Date.now() + timeoutMs; while(Date.now() < end) { const s = await this.state(); if(s.authenticated) return s; if (options.signal?.aborted) throw new BridgeError('aborted', '等待登录已取消。'); await sleep(1000) } throw new BridgeError('manual-auth-timeout','等待登录超时。') }
  async flushModeChange() {
    if (!this.modeChangePending || this.busy || this.generations.size) return false
    if (this.modeChangePromise) return this.modeChangePromise
    const change = (async () => {
      if (this.contextPromise) await this.contextPromise.catch(() => {})
      if (this.busy || this.generations.size) return false
      const mismatch = Boolean(this.context) && this.lastMode?.headed !== this.debugMode
      if (!mismatch) { this.modeChangePending = false; return false }
      await this.closeContext()
      return true
    })()
    const tracked = change.finally(() => { if (this.modeChangePromise === tracked) this.modeChangePromise = null })
    this.modeChangePromise = tracked
    return tracked
  }
  async switchToHeadless({ allowCurrentOperation = false } = {}) {
    if (this.debugMode || !this.lastMode?.headed) return { changed: false, headless: this.headless, pending: this.modeChangePending }
    this.modeChangePending = true
    if (this.active > (allowCurrentOperation ? 1 : 0) || this.generations.size) return { changed: false, headless: false, pending: true }
    if (allowCurrentOperation && this.active === 1) {
      await this.closeContext()
      return { changed: true, headless: true, pending: false }
    }
    const changed = await this.flushModeChange()
    return { changed, headless: this.headless, pending: this.modeChangePending }
  }
  async stop() { await this.persistRegistry(); await this.closeContext(); return { ok: true } }
  async closeContext() {
    if (this.contextPromise) await this.contextPromise.catch(() => {})
    const context = this.context
    this.context = null
    if (context) await context.close().catch(() => {})
    this.pages.clear()
    this.lastMode = null
    this.generations.clear()
    this.modeChangePending = false
  }
  async dispose() { this.disposed = true; await this.stop() }
}
