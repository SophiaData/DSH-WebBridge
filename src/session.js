import { BridgeError } from './envelope.js'
import { loadAdapter, buildReasoningStateExpression, reasoningClickSelector } from './adapters.js'
import { readReplyState, waitForReply } from './detect.js'
import { SITE_PRESETS } from './config.js'
import { uploadProblem } from './attachments.js'
import { randomUUID } from 'node:crypto'
import { buildConversationReadExpression } from './conversation-sync.js'
import { setTimeout as delay } from 'node:timers/promises'
import { createActivity } from './activity.js'

function transientBrowserError(error) {
  return error?.name === 'TimeoutError' || ['read-failed', 'conversation-not-ready', 'composer-not-ready', 'send-not-ready', 'message-not-sent'].includes(error?.code) ||
    /Execution context was destroyed|Cannot find context|Target .*closed|has been closed|frame was detached|element.*detached|net::ERR_|navigation.*interrupted/i.test(error?.message || '')
}

function checkAborted(signal) {
  if (signal?.aborted) throw new BridgeError('aborted', '网页消息发送已取消。')
}

async function pause(ms, signal) {
  try { await delay(ms, undefined, { signal }) }
  catch (error) { checkAborted(signal); throw error }
}

/**
 * One browser chat at a time, on purpose.
 *
 * Nexus learned this the hard way: a shared, single-threaded resource (there it
 * was the runner, here it is one Chrome profile) must be serialized behind a
 * queue, and every request must be able to fail with a stable code instead of
 * corrupting the next caller. `enqueue` gives us exactly that.
 */
export class ChatSession {
  constructor({ settings, driver, log, modelControl }) {
    this.settings = settings
    this.driver = driver
    this.modelControl = modelControl
    this.log = log || (() => {})
    this.chain = Promise.resolve()
    this.sessionId = `chat-session-${randomUUID()}`
    this.last = { site: null, count: 0, text: '', at: null }
    /** sessionKey -> { url } for the DSH-session <-> web-conversation mapping. */
    this.conversations = new Map()
    this.legacyConversationGeneration = randomUUID()
  }

  enqueue(fn, sessionKey = this.sessionId) {
    if (typeof this.driver.exclusive === 'function') return this.driver.exclusive(fn, sessionKey)
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  sitePreset(site = this.settings.site) {
    const preset = SITE_PRESETS[site]
    if (!preset) {
      throw new BridgeError('unknown-site', `Unknown site "${site}". Known: ${Object.keys(SITE_PRESETS).join(', ')}`)
    }
    return preset
  }

  adapter(site = this.settings.site) {
    return loadAdapter(this.settings, site)
  }

  /** Open the site if the active page is elsewhere, then report auth hints. */
  async ensurePage(site, options = {}) {
    const preset = this.sitePreset(site)
    const url = options.url || preset.url
    for (let attempt = 1; attempt <= 3; attempt++) {
      checkAborted(options.signal)
      try {
        options.activity?.emit('page.waiting', '开始等待网页会话就绪', { attempt })
        const state = await this.driver.state()
        if (attempt > 1 || (options.url ? !sameConversationURL(state.url, url) : safeHost(state.url) !== safeHost(url))) {
          await this.driver.open(url, { headed: options.headed, signal: options.signal })
        }
        const ready = await this.authGate(await this.driver.state(), this.adapter(site).inputSelector, options)
        if (options.url && !sameConversationURL(ready.url, url)) throw new BridgeError('conversation-not-ready', '原网页会话尚未恢复，未发送消息。')
        options.activity?.emit('page.ready', '网页会话已就绪')
        return ready
      } catch (error) {
        checkAborted(options.signal)
        if (!transientBrowserError(error)) throw error
        if (attempt === 3) throw new BridgeError('page-not-ready', '已重新连接 3 次，网页仍未就绪。请检查浏览器和网络后重试。', { attempts: attempt, phase: 'connect', cause: error.code || error.name })
        options.activity?.emit('page.retry', '网页暂时不可用，准备重新连接', { attempt: attempt + 1, code: error.code || error.name })
        this.log(`[webbridge] 网页连接暂时不可用，正在重新连接（${attempt + 1}/3）`)
        await pause(Math.min(500, this.settings.commandTimeoutMs || 500), options.signal)
      }
    }
  }

  /** Refuse to act on a login/verification page 鈥?this is a hard rule. */
  async authGate(state, inputSelector, options = {}) {
    checkAborted(options.signal)
    // Sites also show short-lived interstitials ("Just a moment…", bot checks)
    // that clear by themselves; re-check once before calling it a hard failure.
    let current = state
    if (current?.manualAuth?.required) options.activity?.emit('auth.waiting', '检测到登录或验证页面，正在复查', { kind: current.manualAuth.kind })
    for (let attempt = 0; attempt < 2 && current?.manualAuth?.required; attempt++) {
      await pause(Math.min(2500, this.settings.commandTimeoutMs || 2500), options.signal)
      try {
        current = await this.driver.state()
      } catch {
        break
      }
    }

    checkAborted(options.signal)
    const manual = current?.manualAuth
    if (manual?.required) {
      const kind = manual.kind || 'login'
      options.activity?.emit('auth.required', '网页需要用户完成登录或验证', { kind })
      throw new BridgeError(
        `auth-required:${kind}`,
        kind === 'verification'
          ? 'The page requires human verification. Ask the user to finish it in the visible browser, then retry.'
          : 'The page requires sign-in. Ask the user to sign in in the visible browser, then retry.',
        { kind, reasons: manual.reasons || [], url: current.url, headed: current.headless === false },
      )
    }
    return current
  }

  async status() {
    const state = await this.driver.state()
    const adapter = this.adapter()
    return { state, adapter }
  }

  /**
   * Apply the requested reasoning mode before asking. The control is checked on
   * every send because it can change with the selected web model or conversation.
   * A failure here must never block the actual message.
   */
  async ensureReasoning(adapter, signal, mode = 'on') {
    if (!adapter.reasoning?.selector) return { supported: false }
    try {
      const parsed = await this.driver.eval(buildReasoningStateExpression(adapter), { signal })
      const state = parsed?.result || {}
      const selected = mode !== 'off'
      if (!state.found || state.selected === selected) return { ...state, clicked: false }
      const selector = reasoningClickSelector(adapter)
      await this.driver.click(selector, { signal })
      const after = (await this.driver.eval(buildReasoningStateExpression(adapter), { signal }))?.result || {}
      if (after.found && after.selected !== selected) throw new BridgeError('reasoning-not-set', '网页思考开关没有切换到所选模式。')
      this.log(`[webbridge] reasoning ${selected ? 'on' : 'off'}`)
      return { ...after, clicked: true }
    } catch (err) {
      this.log(`[webbridge] reasoning toggle failed (${err.code || 'error'}): ${err.message}`)
      return { supported: true, clicked: false, error: err.code || 'error' }
    }
  }

  /** Select the connector from the + menu without matching sidebar history. */
  async ensurePlugin(adapter, options = {}) {
    const name = adapter.pluginName
    if (!name) return
    const expression = `(() => ({ pluginSelected: Array.from(document.querySelectorAll(${JSON.stringify(adapter.inputSelector)}))
      .filter((node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      .some((node) => Array.from(node.querySelectorAll('[app-mention-display-name]'))
        .some((mention) => mention.getAttribute('app-mention-display-name') === ${JSON.stringify(name)})) }))()`
    const selected = (await this.driver.eval(expression, { signal: options.signal }))?.result?.pluginSelected
    options.activity?.emit('plugin.checked', '已检查输入框中的 MCP 插件', { selected: Boolean(selected) })
    if (selected && !options.attachment && !options.attachments?.length) return {}
    await this.driver.click('button[data-testid="composer-plus-btn"], form button:has(svg use[href*="plus"])', { signal: options.signal })
    const quotaText = (await this.driver.eval(`(() => [...document.querySelectorAll('button')].filter(button=>button.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(button=>button.innerText || '').find(text=>/更多上传额度/.test(text) && /后再上传/.test(text)) || '')()`, { signal: options.signal }))?.result || ''
    const quota = uploadProblem(quotaText)
    if (selected) await this.driver.press('Escape', { signal: options.signal })
    else await this.driver.click(`button[data-plugin-impression-id]:has-text(${JSON.stringify(name)})`, { signal: options.signal })
    if (!(await this.driver.eval(expression, { signal: options.signal }))?.result?.pluginSelected) {
      throw new BridgeError('plugin-not-selected', `The ${name} plugin was not added to the web composer.`)
    }
    this.log(`[webbridge] plugin selected in composer: ${name}`)
    options.activity?.emit('plugin.selected', '已在输入框中选中 MCP 插件')
    return { quota }
  }

  /** Check the actual user turn as well as the draft before deciding to resend. */
  async readSubmission(text, adapter, baseline, signal) {
    checkAborted(signal)
    const sent = await readReplyState(this.driver, adapter, signal)
    if (sent.webStopped) throw new BridgeError('web-generation-stopped', '网页生成已中止。')
    const normalize = value => {
      const content = String(value || '')
      return (adapter.pluginName ? content.split(adapter.pluginName).join('') : content).replace(/\s+/g, '')
    }
    const newTurn = sent.userTurnKey && !sent.userTurnKey.startsWith('fallback-') && sent.userTurnKey !== baseline.userTurnKey
    if (newTurn && normalize(sent.userText) === normalize(text)) return { sent }
    const composer = (await this.driver.eval(`(() => {
      const editors = Array.from(document.querySelectorAll(${JSON.stringify(adapter.inputSelector)}))
        .filter((node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      return { composerCount: editors.length, composerText: editors.map((node) => {
        if (node.value !== undefined) return node.value;
        const copy = node.cloneNode(true);
        copy.querySelectorAll('[app-mention-display-name]').forEach((mention) => mention.remove());
        return copy.textContent || '';
      }).join('\\n') };
    })()`, { signal }))?.result
    // Sites without ChatGPT's turn markers can never satisfy the userTurnKey
    // check above, so a real send would land as "uncertain" forever. For them a
    // send counts as delivered when the draft left the composer and the page
    // reacted: an assistant node appeared, streaming started, or the last
    // reply changed from the pre-send baseline.
    if (adapter.matchReplyToUserTurn === false && adapter.site !== 'gemini') {
      const draftLeft = !(composer?.composerCount > 0) || normalize(composer.composerText) !== normalize(text)
      const reacted = sent.count > baseline.count || Boolean(sent.streaming) ||
        (Boolean(sent.text) && sent.text !== baseline.text)
      if (draftLeft && reacted) return { sent }
    }
    return { unsent: Boolean(composer?.composerCount > 0 && normalize(composer.composerText) === normalize(text) &&
      !sent.streaming && sent.userTurnKey === (baseline.userTurnKey || '')) }
  }

  async confirmSubmission(text, adapter, baseline, options) {
    options.activity?.emit('send.confirming', '开始监听本轮用户消息，确认发送结果')
    const deadline = Date.now() + Math.min(5000, this.settings.commandTimeoutMs || 5000)
    let state
    do {
      checkAborted(options.signal)
      try {
        state = await this.readSubmission(text, adapter, baseline, options.signal)
        if (state.sent) {
          options.activity?.emit('send.confirmed', '监听到本轮用户消息，已确认发送成功', { userTurnKey: state.sent.userTurnKey })
          return state
        }
      } catch (error) {
        if (!transientBrowserError(error)) throw error
        state = null
      }
      await pause(Math.min(100, Math.max(1, deadline - Date.now())), options.signal)
    } while (Date.now() < deadline)
    return state || {}
  }

  /** Recover the same conversation and retry only messages confirmed unsent. */
  async submit(text, site, adapter, options = {}) {
    if (!String(text ?? '').trim()) throw new BridgeError('empty-message', 'Cannot submit an empty web-chat message.')
    const baseline = options.baseline || await readReplyState(this.driver, adapter, options.signal)
    const timeoutMs = Math.min(10000, this.settings.commandTimeoutMs || 10000)
    const command = { signal: options.signal, timeoutMs }
    let recoveryUrl = baseline.url
    let reload = false
    let sendAttempted = false
    let prepared
    let contextAttachmentSkipped = false
    let conversationReset = false
    const delivery = sent => ({
      submittedText: text,
      contextAttachmentDelivered: prepared?.contextAttachmentDelivered === true,
      contextAttachmentSkipped,
      conversationReset,
      userTurnKey: sent.userTurnKey,
      url: sent.url,
      uploadLease: prepared?.lease,
    })
    const resetConversation = async reason => {
      await this.startNewChat(site, options)
      conversationReset = true
      const reset = await options.onConversationReset?.({ reason })
      if (typeof reset?.text === 'string') text = reset.text
      if (!String(text ?? '').trim()) throw new BridgeError('empty-message', 'Cannot submit an empty web-chat message.')
      Object.assign(baseline, await readReplyState(this.driver, adapter, options.signal))
      recoveryUrl = baseline.url
    }
    try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let phase = 'page'
      checkAborted(options.signal)
      try {
        if (sendAttempted) {
          const state = await this.confirmSubmission(text, adapter, baseline, options)
          if (state.sent) return delivery(state.sent)
          if (!state.unsent) throw new BridgeError('message-send-uncertain', '已重新检查网页，但仍无法确认消息是否发出。为避免重复发送，本轮未重发，请检查原网页会话。')
        }
        if (reload) {
          await this.driver.open(recoveryUrl || this.sitePreset(site).url, command)
          const restored = await this.authGate(await this.driver.state(), adapter.inputSelector, options)
          if (persistedConversationURL(site, recoveryUrl, this.sitePreset(site).url) && !sameConversationURL(restored.url, recoveryUrl)) {
            throw new BridgeError('conversation-not-ready', '原网页会话尚未恢复，未重新发送消息。')
          }
          // A delayed send may finish while the original conversation reloads.
          if (sendAttempted && persistedConversationURL(site, recoveryUrl, this.sitePreset(site).url)) {
            const state = await this.readSubmission(text, adapter, baseline, options.signal)
            if (state.sent) return delivery(state.sent)
          }
          await prepared?.lease?.release?.()
          prepared = null
          if (!persistedConversationURL(site, recoveryUrl, this.sitePreset(site).url)) await resetConversation('send-recovery')
          sendAttempted = false
          reload = false
        }
        const page = await this.authGate(await this.driver.state(), adapter.inputSelector, options)
        recoveryUrl ||= page.url
        if (options.webModel) {
          // Strategy dispatch: whatever model source the route carries applies
          // the choice; no site name is consulted here.
          if (!this.modelControl) throw new BridgeError('model-control-unavailable', '网页模型控制尚未就绪，尚未发送消息。')
          options.activity?.emit('model.selecting', '开始等待并选择网页模型控件')
          await this.modelControl.select(options.webModel)
          options.activity?.emit('model.selected', '已确认网页模型选择完成')
        }
        phase = 'fill'
        options.activity?.emit('input.waiting', '开始监听输入框元素', { selector: adapter.inputSelector, attempt })
        if (attempt > 1) await this.driver.fillLong(adapter.inputSelector, '', command)
        await this.driver.fillLong(adapter.inputSelector, text, command)
        options.activity?.emit('input.filled', '已找到输入框元素并填入本轮消息', { selector: adapter.inputSelector, chars: text.length })
        phase = 'prepare'
        // Refilling replaces app mentions. Keep existing uploads until a reload.
        const uploadOptions = contextAttachmentSkipped ? { ...options, attachment: null } : options
        const menu = options.selectPlugin || uploadOptions.attachment || uploadOptions.attachments?.length || attempt > 1
          ? await this.ensurePlugin(adapter, uploadOptions) : null
        if (!prepared) {
          prepared = await this.prepareAttachments(site, uploadOptions, menu?.quota)
          contextAttachmentSkipped ||= prepared.contextAttachmentSkipped === true
          if (prepared.reset) {
            await resetConversation('attachment-quota')
            await this.driver.fillLong(adapter.inputSelector, text, command)
            await this.ensurePlugin(adapter, {})
          }
        }
        if (!options.webModel) await this.ensureReasoning(adapter, options.signal, options.reasoning || 'on')
        if (options.watchId && this.driver.startGenerationWatch) {
          await this.driver.startGenerationWatch(options.watchId, command)
          options.activity?.emit('generation.listening', '已开始监听网页生成状态和停止按钮')
        }
        checkAborted(options.signal)
        phase = 'send'
        const sendSelector = adapter.sendSelector || this.sitePreset(site).adapter.sendSelector
        let clickError
        sendAttempted = true
        options.activity?.emit('send.waiting', '开始监听发送按钮元素', { selector: sendSelector, attempt })
        try {
          await this.driver.click(sendSelector, command)
          options.activity?.emit('send.clicked', '已找到发送按钮元素并点击', { selector: sendSelector })
        } catch (error) {
          clickError = error
          options.activity?.emit('send.click-failed', '点击发送按钮失败，正在检查消息是否已经送出', { code: error.code || error.name })
        }
        let state = await this.confirmSubmission(text, adapter, baseline, options)
        if (state.sent) return delivery(state.sent)
        await this.authGate(await this.driver.state(), adapter.inputSelector, options)
        if (!state.unsent) {
          this.log('[webbridge] 发送结果暂时不明确，正在重新检查本轮用户消息')
          state = await this.confirmSubmission(text, adapter, baseline, options)
          if (state.sent) return delivery(state.sent)
          if (!state.unsent) throw new BridgeError('message-send-uncertain', '已重新检查网页，但仍无法确认消息是否发出。为避免重复发送，本轮未重发，请检查原网页会话。')
        }
        throw clickError || new BridgeError('message-not-sent', '消息仍在输入框中，尚未发送。')
      } catch (error) {
        checkAborted(options.signal)
        if (!transientBrowserError(error)) throw error
        if (attempt === 3) {
          const code = error.code || (phase === 'fill' ? 'composer-not-ready' : phase === 'send' ? 'send-not-ready' : 'page-not-ready')
          throw new BridgeError(code, `已尝试恢复并发送 3 次，${phase === 'fill' ? '输入框仍不可用' : phase === 'send' ? '消息仍未发出' : '网页仍未就绪'}。请检查原网页会话后重试。`, { attempts: attempt, phase, cause: error.code || error.name })
        }
        reload = reload || phase !== 'send' || attempt === 2
        options.activity?.emit('send.retry', '准备恢复网页并重试发送', { phase, attempt: attempt + 1, reload, code: error.code || error.name })
        this.log(`[webbridge] ${phase} 阶段暂时失败，${reload ? '正在重新打开原会话' : '正在清空输入框并重新发送'}（${attempt + 1}/3）`)
        await pause(Math.min(250, timeoutMs), options.signal)
      }
    }
    } catch (error) { await prepared?.lease?.release?.(); throw error }
  }

  async prepareAttachments(site, options, menuQuota) {
    if (!options.attachment && !options.attachments?.length) return { contextAttachmentDelivered: false, contextAttachmentSkipped: false }
    options.activity?.emit('attachments.uploading', '开始上传本轮附件', { count: Number(Boolean(options.attachment)) + (options.attachments?.length || 0) })
    let lease
    let attempted = false
    try {
      if (menuQuota) throw new BridgeError(menuQuota.code, menuQuota.message)
      const before = await this.uploadState(options.signal)
      if (before?.problem?.code === 'attachment-quota-exceeded') throw new BridgeError(before.problem.code, before.problem.message)
      attempted = true
      if (this.driver.attachFiles) {
        lease = await this.driver.attachFiles([...(options.attachment ? [options.attachment] : []), ...(options.attachments || [])], { signal: options.signal })
      } else if (options.attachment && !options.attachments?.length && this.driver.attachTextFile) {
        const attached = await this.driver.attachTextFile(options.attachment.name, options.attachment.content, { signal: options.signal })
        if (attached?.ok === false) throw new BridgeError('attachment-upload-failed', '网页没有接受系统上下文附件。')
      } else throw new BridgeError('attachment-upload-unavailable', 'The browser driver cannot upload these attachments.')
      await this.waitUploads(options.signal)
      options.activity?.emit('attachments.ready', '本轮附件已上传完成')
      return { lease, contextAttachmentDelivered: Boolean(options.attachment), contextAttachmentSkipped: false }
    } catch (error) {
      await lease?.release?.()
      if (error.code !== 'attachment-quota-exceeded' || options.attachments?.length || !options.attachment) throw error
      this.log('[webbridge] attachment quota reached; skipping system TXT and preserving user text with the app')
      options.activity?.emit('attachments.skipped', '附件额度不足，已跳过系统上下文文件', { code: error.code })
      await this.dismissUploadNotice()
      return { reset: attempted, contextAttachmentDelivered: false, contextAttachmentSkipped: true }
    }
  }

  async send(text, options = {}) {
    return this.enqueue(async () => {
      const site = options.site || this.settings.site
      const adapter = this.adapter(site)
      if (!adapter.inputSelector) {
        throw new BridgeError('adapter-incomplete', `Adapter for "${site}" has no inputSelector. Run webbridge_adapter to calibrate.`)
      }
      await this.ensurePage(site, options)

      const baseline = await readReplyState(this.driver, adapter, options.signal)
      await this.submit(text, site, adapter, { ...options, baseline })

      this.last = { site, count: baseline.count, text: baseline.text, at: Date.now() }
      return { site, baseline, sentAt: Date.now() }
    })
  }

  async read(options = {}) {
    return this.enqueue(async () => {
      const site = options.site || this.settings.site
      const adapter = this.adapter(site)
      const state = await readReplyState(this.driver, adapter, options.signal)
      return { site, ...state }
    })
  }

  async ask(text, options = {}) {
    const queueKey = options.sessionKey ? `${options.site || this.settings.site}:${options.sessionKey}` : this.sessionId
    const activity = options.activity || createActivity(this.settings, this.log, { sessionId: options.sessionKey || this.sessionId, site: options.site || this.settings.site })
    options = { ...options, activity }
    activity.emit('request.queued', '网页请求已进入会话队列', { chars: String(text).length })
    return this.enqueue(async () => {
      activity.emit('request.started', '开始处理网页请求')
      this.driver.activities?.set(queueKey, activity)
      let uploaded
      let watchId
      let preservePage = false
      try {
      const site = options.site || this.settings.site
      const adapter = this.adapter(site)
      if (!adapter.inputSelector) {
        throw new BridgeError('adapter-incomplete', `Adapter for "${site}" has no inputSelector. Run webbridge_adapter to calibrate.`)
      }
      // One DSH session = one web conversation. The provider passes its
      // sessionId, we remember the concrete chat URL and reopen it next time
      // instead of appending to whatever tab happens to be active.
      const key = options.sessionKey ? `${site}:${options.sessionKey}` : null
      let known = key ? (this.conversations.get(key) || await this.driver.getSessionInfo?.(key) || null) : null
      // The driver also records navigation to a site root. That is not a
      // retained conversation and must not reuse an old context generation.
      if (known?.url && !persistedConversationURL(site, known.url, this.sitePreset(site).url)) known = { ...known, url: '' }
      let newConversation = known?.needsContext === true
      let generation = known?.generation || (key ? randomUUID() : this.legacyConversationGeneration)
      if (key && known) this.conversations.set(key, known)
      if (known?.url || known?.pending) {
        let current
        try { current = await this.driver.state() }
        catch (error) { if (!transientBrowserError(error)) throw error; current = {} }
        // A pending blank conversation can survive a restart without a URL.
        // Its newly recreated browser page starts at about:blank, so restore
        // the site and verify a fresh chat before preparing the first message.
        if (key && known.pending && !known.url && !String(current?.url || '').includes(safeHost(this.sitePreset(site).url))) {
          await this.ensurePage(site, options)
          await this.startNewChat(site, options)
          current = await this.driver.state()
          generation = randomUUID()
          newConversation = true
          known = { ...known, url: '', pending: true, generation, needsContext: true, userTurnKey: '' }
          this.conversations.set(key, known)
          await this.driver.updateSessionInfo?.(key, known)
        }
        if (known.pending && persistedConversationURL(site, current?.url, this.sitePreset(site).url)) { known.url = current.url; known.pending = false }
        await this.ensurePage(site, { ...options, ...(known.url ? { url: known.url } : {}) })
      } else {
        // A new DSH session must not inherit whatever conversation the tab
        // currently shows: start a fresh web chat so one DSH session maps to
        // exactly one web conversation. Switch to the right site first — the
        // shortcut only works on the site's own page.
        await this.ensurePage(site, options)
        if (key) {
          await this.startNewChat(site, options)
          newConversation = true
          generation = randomUUID()
          known = { url: '', pending: true, generation, needsContext: true }
          this.conversations.set(key, known)
          await this.driver.updateSessionInfo?.(key, { ...known, userTurnKey: '', title: '' })
        }
      }
      // The provider can choose a full snapshot or a continuation only after
      // this method has selected the actual web conversation. Page hydration
      // and restoring the same URL do not themselves invalidate context.
      let conversation = {
        key, conversationKey: key, site,
        url: known?.url || String((await this.driver.state())?.url || ''),
        newConversation, reset: newConversation,
        reason: newConversation ? known?.contextResetReason || 'new-chat' : 'resume',
        generation,
      }
      const sendOptions = { ...options }
      const prepareMessage = async (info) => {
        conversation = info
        await options.onConversation?.(info)
        const update = await options.prepareMessage?.(info)
        if (update == null) return
        if (typeof update === 'string') { text = update; return }
        if (typeof update !== 'object' || Array.isArray(update)) {
          throw new BridgeError('invalid-message-preparation', 'prepareMessage must return text or a message object.')
        }
        if (Object.hasOwn(update, 'text')) {
          if (typeof update.text !== 'string') throw new BridgeError('invalid-message-preparation', 'Prepared message text must be a string.')
          text = update.text
        }
        for (const field of ['attachment', 'attachments']) {
          if (Object.hasOwn(update, field)) sendOptions[field] = update[field]
        }
      }
      await prepareMessage(conversation)
      activity.emit('conversation.selected', '已选定本轮网页会话', { newConversation, generation })
      if ((sendOptions.attachment || sendOptions.attachments?.length) && this.driver.prepareUploads) await this.driver.prepareUploads()

      const baseline = await readReplyState(this.driver, adapter, options.signal)
      // A restored page may not have hydrated yet. Keep the last known user
      // turn as the baseline so its old answer cannot satisfy this request.
      if (!baseline.userTurnKey && known?.userTurnKey) baseline.userTurnKey = known.userTurnKey
      const started = Date.now()
      watchId = randomUUID()
      const submitted = await this.submit(text, site, adapter, {
        ...sendOptions, baseline, watchId, selectPlugin: Boolean(adapter.pluginName && !known?.url),
        onConversationReset: async ({ reason }) => {
          newConversation = true
          generation = randomUUID()
          known = { url: '', pending: true, generation, needsContext: true, contextResetReason: reason }
          if (key) {
            this.conversations.set(key, known)
            await this.driver.updateSessionInfo?.(key, { ...known, userTurnKey: '', title: '' })
          } else this.legacyConversationGeneration = generation
          const info = { key, conversationKey: key, site, url: String((await this.driver.state())?.url || ''), newConversation: true, reset: true, reason, generation }
          await options.onConversationReset?.(info)
          await prepareMessage(info)
          // The upload has already failed. A rewritten first message may
          // carry a full-context reference, but no attachment is retried here.
          return { text }
        },
      })
      uploaded = submitted?.uploadLease
      if (typeof submitted?.submittedText === 'string') text = submitted.submittedText
      if (key) {
        const url = submitted?.url || ''
        const persisted = persistedConversationURL(site, url, this.sitePreset(site).url)
        const savedConversation = { ...known, ...(persisted ? { url } : {}), pending: !persisted, generation, needsContext: false, contextResetReason: '', userTurnKey: submitted?.userTurnKey || '' }
        this.conversations.set(key, savedConversation)
        if (persisted) await this.driver.updateSessionInfo?.(key, { url, generation, pending: false, needsContext: false, contextResetReason: '' })
      }
      const submission = { ...(submitted || {}), conversation, conversationReset: newConversation || submitted?.conversationReset === true }
      options.onSubmitted?.(submission)

      activity.emit('reply.listening', '开始监听本轮回复元素，等待网页回复', { selector: adapter.messageSelector, expectedTurnKey: submitted?.userTurnKey || '' })
      if (adapter.matchReplyToUserTurn) await this.driver.scrollToBottom?.({ signal: options.signal })
      const reply = await waitForReply({
        driver: this.driver,
        adapter,
        baseline,
        settings: this.settings,
        signal: options.signal,
        log: this.log,
        expectedText: text,
        expectedTurnKey: submitted?.userTurnKey || '',
        onReconnect: this.driver.reconnectReply ? ({ turnKey }) => this.driver.reconnectReply({
          turnKey, url: submitted?.url || conversation.url, signal: options.signal,
        }) : undefined,
        onProgress: options.onProgress,
        activity,
      })
      // Container-less sites: the read returns the whole conversation, so drop
      // everything up to and including the prompt we just sent.
      if (adapter.stripPrompt) {
        const marker = String(text).slice(0, Math.min(40, String(text).length))
        const at = marker ? reply.text.lastIndexOf(marker) : -1
        if (at >= 0) reply.text = reply.text.slice(at + marker.length).trim()
      }
      this.last = { site, count: reply.count, text: reply.text, at: Date.now() }
      activity.emit('reply.captured', reply.truncated ? '已读取本轮部分回复' : '已读取本轮完整回复', { chars: reply.text.length, truncated: reply.truncated, replyId: reply.replyId })
      // After the exchange is over the site has definitely assigned the concrete
      // conversation URL, and the page title carries the conversation title
      // ("Reply cherry"). Remember both, so the next turn reopens this chat
      // instead of starting yet another one.
      let title = null
      if (key) {
        try {
          const current = await this.driver.state()
          const entry = this.conversations.get(key) || {}
          const url = String(current?.url || '')
          if (persistedConversationURL(site, url, this.sitePreset(site).url)) { entry.url = url; entry.pending = false }
          if (reply.userTurnKey) entry.userTurnKey = reply.userTurnKey
          if (reply.replyId) entry.replyId = reply.replyId
          if (this.sitePreset(site).readTitle !== false) {
            title = String(current?.title || '').trim() || null
            if (title) entry.title = title
          }
          this.conversations.set(key, entry)
          if (entry.url) await this.driver.updateSessionInfo?.(key, { url: entry.url, title: entry.title || '', generation, pending: false, needsContext: false, contextResetReason: '' })
        } catch {}
      }
      return { site, reply: reply.text, title, ...reply, totalMs: Date.now() - started,
        submittedText: text, conversation,
        conversationReset: submission.conversationReset,
        contextAttachmentDelivered: submitted?.contextAttachmentDelivered === true,
        contextAttachmentSkipped: submitted?.contextAttachmentSkipped === true,
      }
      } catch (error) {
        activity.emit('browser-request.failed', '网页请求已结束', { code: error.code || error.name })
        preservePage = error.code === 'message-send-uncertain'
        throw error
      } finally {
        if (watchId && options.signal?.aborted && this.driver.stopGeneration) await this.driver.stopGeneration(watchId).catch(() => {})
        if (watchId && this.driver.endGenerationWatch) await this.driver.endGenerationWatch(watchId).catch(() => {})
        await uploaded?.release?.()
        if (options.sessionKey && !preservePage) await this.driver.releasePage?.(queueKey)
        if (this.driver.activities?.get(queueKey) === activity) this.driver.activities.delete(queueKey)
        activity.emit('request.released', preservePage ? '已保留发送结果不明的网页现场' : '本轮网页操作已清理结束')
      }
    }, queueKey)
  }

  async waitUploads(signal) {
    const until = Date.now() + 120000
    while (Date.now() < until) {
      if (signal?.aborted) throw new BridgeError('aborted', '附件上传已取消。')
      const result = await this.uploadState(signal)
      if (result?.problem) throw new BridgeError(result.problem.code, result.problem.message)
      if (!result?.uploading) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        const settled = await this.uploadState(signal)
        if (settled?.problem) throw new BridgeError(settled.problem.code, settled.problem.message)
        if (!settled?.uploading) return
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new BridgeError('attachment-upload-timeout', '附件上传超时，尚未发送消息。')
  }

  async uploadState(signal) {
    return (await this.driver.eval(`(() => {
        const visible = el => el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
        const text = document.body?.innerText || '';
        const uploading = [...document.querySelectorAll('[role="progressbar"], [aria-label*="正在上传"], [aria-label*="Uploading"]')].some(visible) || /正在上传|正在处理文件|上传中|Uploading|Processing\\s+file/i.test(text);
        const parseProblem = ${uploadProblem.toString()};
        return {problem:parseProblem(text),uploading};
      })()`, { signal })).result
  }

  async dismissUploadNotice() {
    for (const selector of [
      '[role="dialog"] button:text-is("取消")',
      '[role="alertdialog"] button:text-is("取消")',
      '[role="dialog"] button:text-is("Cancel")',
      'button[aria-label="关闭对话框"]',
    ]) {
      const result = await this.driver.run('query', [selector]).catch(() => null)
      if (result?.items?.some(item => item.rect?.width > 0 && item.rect?.height > 0)) {
        await this.driver.click(selector)
        return
      }
    }
    await this.driver.press('Escape')
  }

  /**
   * Start a new web conversation.
   *
   * Opening the site root is not enough: ChatGPT restores the previous chat on
   * load, so both DSH sessions ended up in one conversation. Click the sidebar
   * "新聊天" control first and only fall back to a plain navigation.
   */
  /**
   * Wait until the page shows an empty chat (no reply nodes). The client-side
   * route swaps the URL first and the message list later, so this is the only
   * reliable "a new chat is really ready" signal.
   */
  async waitBlank(site, options = {}) {
    const adapter = this.adapter(site)
    const deadline = Date.now() + (options.timeoutMs || 15000)
    while (Date.now() < deadline) {
      try {
        const state = await readReplyState(this.driver, adapter, options.signal)
        // Gemini can render an empty reply list while a previous user-query is
        // still present. Require the blank /app route and no user turn as well.
        const geminiBlank = site !== 'gemini' || (state.url && !state.userTurnKey && /^\/app\/?$/.test(new URL(state.url).pathname))
        if (state.count === 0 && geminiBlank && (!this.driver.composerBlank || await this.driver.composerBlank(adapter.inputSelector, { signal: options.signal }))) return true
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return false
  }

  async startNewChat(site, options = {}) {
    options.activity?.emit('conversation.resetting', '正在等待网页清空并创建新会话')
    const preset = this.sitePreset(site)
    // Gemini assigns /app/<id> on first submission; /app is its blank-chat route.
    // Never try the ChatGPT new-chat shortcut or sidebar selector on Gemini.
    if (site === 'gemini') {
      await this.driver.open(preset.url, { headed: options.headed, signal: options.signal })
      if (!await this.waitBlank(site, options)) throw new BridgeError('new-chat-not-ready', 'Gemini 未进入空白会话，未发送消息。')
      return 'gemini-app'
    }
    // Verified 2026-11-17: opening the site root does NOT reset the chat (the
    // profile restores the last conversation), while the keyboard shortcut
    // always lands on a blank composer at the top level URL.
    if (preset.newChatShortcut) {
      try {
        await this.driver.press(preset.newChatShortcut, { signal: options.signal })
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const st = await this.driver.state().catch(() => null)
        // The URL changes before the message list is swapped. Give the blank
        // chat a moment to render so the reply baseline is taken on the new
        // page (a stale baseline makes the reply look like it never arrived).
        const empty = await this.waitBlank(site, { signal: options.signal, timeoutMs: 12000 })
        const blank = Boolean(st?.url) && !String(st.url).includes('/c/')
        this.log(`[webbridge] new-chat shortcut ${preset.newChatShortcut} -> ${st?.url || 'unknown'} blank=${blank} empty=${empty}`)
        if (!blank || !empty) throw new BridgeError('new-chat-not-ready', '网页新会话尚未清空，请检查浏览器。')
        return 'shortcut'
      } catch (err) {
        this.log(`[webbridge] new-chat shortcut failed (${err.code || 'error'}); trying the button`)
      }
    }
    // One click, no retries: ChatGPT creates the conversation only when the
    // first message is sent, so verifying the URL here always looked like a
    // failure and the retry loop kept hopping between conversations.
    try {
      const selector = this.adapter(site).newChatSelector || 'a[data-testid="create-new-chat-button"], nav a[href="/"]'
      await this.driver.click(selector, { signal: options.signal, timeoutMs: 8000 })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (!await this.waitBlank(site, options)) throw new BridgeError('new-chat-not-ready', '网页新会话尚未清空，请检查浏览器。')
      return 'new-chat'
    } catch (err) {
      this.log(`[webbridge] new-chat click failed (${err.code || 'error'}); navigating to the site root`)
      await this.driver.open(preset.url, { headed: options.headed, signal: options.signal })
      if (!await this.waitBlank(site, options)) throw new BridgeError('new-chat-not-ready', '无法打开空白网页会话，尚未发送消息。')
      return preset.url
    }
  }

  /** Inspect the web chat mapped to one DSH session; never create or switch chats. */
  async readConversation(options = {}) {
    const site = options.site || this.settings.site
    const sessionKey = String(options.sessionKey || '').trim()
    if (!sessionKey) throw new BridgeError('session-required', '读取网页消息需要当前 DSH sessionId。')
    const key = site + ':' + sessionKey
    return this.enqueue(async () => {
      if (site === 'gemini') throw new BridgeError('sync-not-supported', 'Gemini 暂不支持回填网页历史到 DSH；未修改本地会话。')
      const preset = this.sitePreset(site)
      const known = this.conversations.get(key) || await this.driver.getSessionInfo?.(key)
      const url = String(known?.url || '')
      if (!persistedConversationURL(site, url, preset.url) ||
          new URL(url).origin !== new URL(preset.url).origin) {
        throw new BridgeError('sync-no-conversation', '当前本地会话没有已关联的 ChatGPT 网页对话，未执行同步。')
      }
      try {
        const current = await this.driver.state()
        if (current?.url !== url) await this.driver.open(url, { signal: options.signal })
        await this.authGate(await this.driver.state(), this.adapter(site).inputSelector)
        let read
        const expected = new URL(url)
        for (let attempt = 0; attempt < 16; attempt++) {
          read = (await this.driver.eval(buildConversationReadExpression(), { signal: options.signal }))?.result
          const actual = new URL(String(read?.url || 'about:blank'))
          if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
            throw new BridgeError('sync-conversation-changed', '网页跳转到了另一段对话，未修改本地会话。')
          }
          if (read?.streaming) throw new BridgeError('sync-web-busy', '网页正在生成回复，请结束后再同步。')
          if (Array.isArray(read?.messages) && read.messages.length) break
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        if (!Array.isArray(read?.messages) || !read.messages.length) {
          throw new BridgeError('sync-no-messages', '网页未加载出完整的对话内容，未修改本地会话。')
        }
        const replyState = await readReplyState(this.driver, this.adapter(site), options.signal)
        if (replyState?.streaming || replyState?.requestActive) {
          throw new BridgeError('sync-web-busy', '网页正在生成回复，请结束后再同步。')
        }
        return { ...read, site, url }
      } finally {
        await this.driver.releasePage?.(key)
      }
    }, key)
  }

  async newChat(options = {}) {
    const queueKey = options.sessionKey ? `${options.site || this.settings.site}:${options.sessionKey}` : this.sessionId
    return this.enqueue(async () => {
      const site = options.site || this.settings.site
      const result = await this.startNewChat(site, options)
      const key = options.sessionKey ? `${site}:${options.sessionKey}` : null
      const generation = randomUUID()
      const entry = { url: '', pending: true, generation, needsContext: true, contextResetReason: 'manual-reset', userTurnKey: '', title: '' }
      if (key) {
        this.conversations.set(key, entry)
        await this.driver.updateSessionInfo?.(key, entry)
      } else this.legacyConversationGeneration = generation
      const url = String((await this.driver.state())?.url || result || '')
      const conversation = { key, conversationKey: key, site, url, newConversation: true, reset: true, reason: 'manual-reset', generation }
      await options.onConversationReset?.(conversation)
      await options.onConversation?.(conversation)
      this.last = { site, count: 0, text: '', at: Date.now() }
      return { site, url, adapterSource: this.adapter(site).source, conversation }
    }, queueKey)
  }
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url)
  }
}

function sameConversationURL(actual, expected) {
  try {
    const left = new URL(actual), right = new URL(expected)
    return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
  } catch { return false }
}

export function persistedConversationURL(site, value, root) {
  try {
    const url = new URL(String(value || ''))
    const home = new URL(root)
    if (url.origin !== home.origin || url.pathname.replace(/\/$/, '') === home.pathname.replace(/\/$/, '')) return false
    if (site === 'gemini') return /^\/app\/[A-Za-z0-9_-]+$/.test(url.pathname)
    return /\/c\//.test(url.pathname) && !/\/c\/(?:local-chatgpt|local_)/i.test(decodeURIComponent(url.pathname))
  } catch { return false }
}

