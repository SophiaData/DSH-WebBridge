import { BridgeError } from '../envelope.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const MODE_TRIGGER = '[data-test-id="bard-mode-menu-button"]'
const MODE_MENU = '[data-test-id="gem-mode-menu"], [data-test-id="bard-mode-desktop-gem-menu"]'
const REASONING_ITEM = '思考等级'
const GEMINI_URL = 'https://gemini.google.com/app'
const REASONING_LEVELS = [
  { label: '低', description: '快速、高效', power: 0 },
  { label: '中', description: '深度适中', power: 1 },
  { label: '高', description: '超级详尽', power: 2 },
]

const READ_EXPRESSION = `(() => {
  const trigger = document.querySelector('${MODE_TRIGGER}');
  const label = trigger ? ((trigger.innerText || trigger.textContent || '').trim() || trigger.getAttribute('aria-label') || '') : '';
  return { label };
})()`

const LIST_EXPRESSION = `(() => {
  const label = el => ((el.innerText || el.textContent || '').trim() || '').replace(/\\s+/g, ' ');
  const menus = Array.from(document.querySelectorAll('${MODE_MENU}'));
  const root = menus.find(menu => menu.getAttribute('data-test-id') === 'gem-mode-menu') || menus[0];
  if (!root) return [];
  return Array.from(root.querySelectorAll('[role="menuitemradio"]')).map((el, index) => {
    const text = label(el);
    const bits = text.split('\\n').map(item => item.trim()).filter(Boolean);
    const name = bits[0] || text;
    const sublabel = bits[1] || name;
    return { name, sublabel, testId: el.getAttribute('data-test-id') || '', selected: /\\bselected\\b/.test(el.className || ''), index };
  });
})()`

const REASONING_EXPRESSION = `(() => {
  const items = Array.from(document.querySelectorAll('${MODE_MENU} [role="menuitemradio"]'));
  const reasoning = items.find(el => ((el.innerText || el.textContent || '').trim() || '').includes('${REASONING_ITEM}'));
  return Boolean(reasoning);
})()`

const READ_REASONING_EXPRESSION = `(() => {
  const text = el => ((el.innerText || el.textContent || '').trim() || '').replace(/\\s+/g, ' ');
  const menus = Array.from(document.querySelectorAll('${MODE_MENU}'));
  const root = menus.find(menu => menu.getAttribute('data-test-id') === 'gem-mode-menu') || menus[0];
  if (!root) return '';
  const options = Array.from(root.querySelectorAll('[role="menuitemradio"]'))
    .map(el => text(el))
    .filter(value => /^(低|中|高)[\\s　]/.test(value));
  const selected = options.find(value => /\\bselected\\b/.test(value)) || options[0] || '';
  return selected.split(' ')[0];
})()`

const MENU_EXPRESSION = `(() => Array.from(document.querySelectorAll('${MODE_MENU}')).some(menu => menu.querySelectorAll('[role="menuitemradio"]').length > 0))()`

function parseModeLabel(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim()
  const match = text.match(/(4\s+[A-Za-z]+|[A-Za-z][A-Za-z0-9 ]*)$/)
  return match ? match[1].trim() : (text || 'Gemini')
}

function sameMode(left, right) {
  const normalize = value => String(value || '').replace(/\s+/g, '').replace(/^4/, '').toLowerCase()
  const a = normalize(left)
  const b = normalize(right)
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)))
}

/** Gemini mode catalog driven by the live mode picker; no fixed model names. */
export class GeminiModels {
  constructor({ settings, driver, log = () => {}, onChange = () => {} }) {
    this.settings = settings
    this.driver = driver
    this.log = log
    this.onChange = onChange
    this.catalog = []
    this.checkedAt = 0
    this.reasoningAvailable = false
    const configured = settings?.providers?.geminiCatalogPath
    this.path = configured ? resolve(configured) : null
    this.loaded = false
  }

  async load() {
    if (this.loaded || !this.path) return
    this.loaded = true
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'))
      if (Array.isArray(saved.models) && saved.models.length) {
        this.catalog = saved.models
        this.checkedAt = Number(saved.checkedAt) || 0
      }
    } catch {}
  }

  async persist() {
    if (!this.path || !this.catalog.length) return
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(this.path, JSON.stringify({ version: 1, checkedAt: this.checkedAt, models: this.catalog }, null, 2), { mode: 0o600 })
    } catch {}
  }

  async currentName() {
    try {
      const { result } = await this.driver.eval(READ_EXPRESSION)
      return parseModeLabel(result?.label)
    } catch (error) {
      this.log(`[webbridge:models] gemini mode label read failed: ${error.message}`)
      return 'Gemini'
    }
  }

  async currentReasoningLevel() {
    try {
      await this.openMenu()
      const { result } = await this.driver.eval(READ_REASONING_EXPRESSION)
      return String(result || '低').trim()
    } catch (error) {
      this.log(`[webbridge:models] gemini reasoning level read failed: ${error.message}`)
      return '低'
    } finally {
      await this.closeMenu().catch(() => {})
    }
  }

  async openMenu() {
    const state = await this.driver.state()
    if (state?.manualAuth?.required) throw new BridgeError('auth-required:login', '请先登录 Gemini 网页。')
    if (!/^https:\/\/gemini\.google\.com\/app/.test(String(state?.url || ''))) {
      await this.driver.open(GEMINI_URL)
    }
    await this.driver.click(MODE_TRIGGER)
    return state
  }

  async closeMenu() {
    await this.driver.press('Escape').catch(() => {})
  }

  async readMenu() {
    await this.openMenu()
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const { result } = await this.driver.eval(MENU_EXPRESSION)
        if (result === true) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      const { result } = await this.driver.eval(LIST_EXPRESSION)
      const modes = Array.isArray(result) ? result : []
      const { result: reasoning } = await this.driver.eval(REASONING_EXPRESSION)
      this.reasoningAvailable = Boolean(reasoning)
      return modes
    } finally {
      await this.closeMenu()
    }
  }

  async list(force = false) {
    await this.load()
    if (!force && Date.now() - this.checkedAt < 300000 && this.catalog.length) return this.catalog
    const operation = async () => {
      try {
        const modes = await this.readMenu()
        if (!modes.length) return this.catalog
        const current = await this.currentName()
        const modeItems = modes.filter(mode => !/^(低|中|高)[\s　]/.test(String(mode.name || '')))
        const catalog = modeItems.map((mode, index) => {
          const modelName = mode.name || parseModeLabel(mode.sublabel)
          return {
          key: `mode-${index}`,
            modelName,
            power: 0,
            label: mode.sublabel || modelName,
            effort: '',
            preferred: mode.selected || (!modes.some(item => item.selected) && Boolean(current && sameMode(modelName, current))),
            testId: mode.testId,
            index,
            reasoning: REASONING_LEVELS.map(level => ({ ...level })),
          }
        })
        if (JSON.stringify(catalog.map(item => [item.modelName, item.label, item.preferred])) !== JSON.stringify(this.catalog.map(item => [item.modelName, item.label, item.preferred]))) {
          this.catalog = catalog
          Promise.resolve().then(() => this.onChange()).catch(() => this.log('[webbridge:models] gemini model-change notification failed'))
        }
        this.checkedAt = Date.now()
        await this.persist()
        return this.catalog
      } catch (error) {
        this.checkedAt = Date.now()
        if (force) throw error
        this.log(`[webbridge:models] gemini catalog read failed: ${error.code || error.message}`)
        return this.catalog
      }
    }
    return operation()
  }

  async select(choice) {
    if (!choice?.modelName) throw new BridgeError('model-unavailable', '未指定 Gemini 模式。')
    let catalog = this.catalog
    if (!catalog.length) catalog = await this.list(true)
    const match = catalog.find(item => item.modelName === choice.modelName || item.label === choice.label)
    if (!match) throw new BridgeError('model-unavailable', `Gemini 当前模式列表中没有 ${choice.modelName}。`)
    await this.openMenu()
    try {
      await this.driver.click(`${MODE_MENU} [role="menuitemradio"] >> nth=${match.index}`)
      const requestedPower = Number(choice.power)
      if (Number.isInteger(requestedPower)) {
        const level = REASONING_LEVELS.find(item => item.power === requestedPower)
        if (level) {
          await this.driver.click(`${MODE_MENU} gem-menu-item[role="menuitem"]:has-text("${REASONING_ITEM}")`)
          const options = this.driver.locator?.('[role="menuitemradio"]')
          if (options) {
            const index = await options.evaluateAll(nodes => nodes.findIndex(node => ((node.innerText || '').trim() || '').startsWith(level.label)))
            if (index >= 0) await options.nth(index).click()
          } else {
            await this.driver.click(`[role="menuitemradio"]:has-text("${level.label}")`)
          }
        }
      }
      await this.closeMenu()
      const selected = parseModeLabel(await this.currentName())
      if (!sameMode(selected, match.modelName) && !sameMode(selected, match.label)) throw new BridgeError('model-not-selected', `未能将 Gemini 模式切换为 ${match.modelName}。`)
      return { ...match, power: Number.isInteger(requestedPower) ? requestedPower : 0, label: match.label }
    } catch (error) {
      await this.closeMenu().catch(() => {})
      throw error
    }
  }
}
