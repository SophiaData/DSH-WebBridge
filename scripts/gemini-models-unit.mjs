import test from 'node:test'
import assert from 'node:assert/strict'
import { GeminiModels } from '../src/models/gemini.js'
import { WebChatAdapter } from '../src/provider.js'

function driverFixture() {
  const evaluations = []
  const clicks = []
  let current = '4 Hydrogen'
  const driver = {
    state: async () => ({ url: 'https://gemini.google.com/app', manualAuth: { required: false } }),
    getPageFor: async () => null,
    click: async selector => { clicks.push(selector); return { ok: true } },
    open: async url => { clicks.push(`open:${url}`) },
    press: async key => { clicks.push(`press:${key}`) },
    eval: async expression => {
      evaluations.push(expression)
      if (expression.includes('const trigger')) return { result: { label: current } }
      if (expression.includes("includes('思考等级')")) return { result: true }
      if (expression.includes('思考等级') && expression.includes('innerText')) return { result: '中' }
      if (expression.includes('.some(menu => menu.querySelectorAll')) return { result: true }
      if (expression.includes('const menus = Array.from')) return { result: [
        { name: '自动', sublabel: '根据需求调整回答', testId: 'mode-auto', selected: false, index: 0, reasoning: [{ power: 0, label: '低' }, { power: 1, label: '中' }, { power: 2, label: '高' }] },
        { name: '日常帮助', sublabel: '4 Hydrogen', testId: 'mode-hydrogen', selected: true, index: 1, reasoning: [{ power: 0, label: '低' }, { power: 1, label: '中' }, { power: 2, label: '高' }] },
        { name: '更深入的分析', sublabel: '4 Neon', testId: 'mode-neon', selected: false, index: 2, reasoning: [{ power: 0, label: '低' }, { power: 1, label: '中' }, { power: 2, label: '高' }] },
      ] }
      if (expression.includes('querySelectorAll(\'[role="menuitemradio"]\')')) {
        return { result: [] }
      }
      return { result: null }
    },
  }
  return { driver, clicks, evaluations, setCurrent: value => { current = value } }
}

test('GeminiModels reads the live mode picker into a flat catalog', async () => {
  const { driver } = driverFixture()
  const models = new GeminiModels({ settings: {}, driver })
  const catalog = await models.list(true)
  assert.deepEqual(catalog.map(item => item.modelName), ['自动', '日常帮助', '更深入的分析'])
  assert.equal(catalog[1].label, '4 Hydrogen')
  assert.equal(catalog[1].preferred, true)
})

test('GeminiModels selects by catalog index and verifies the new mode', async () => {
  const { driver, clicks, setCurrent } = driverFixture()
  const models = new GeminiModels({ settings: {}, driver })
  const catalog = await models.list(true)
  setCurrent('4 Neon')
  const selected = await models.select(catalog[2])
  assert.equal(selected.modelName, '更深入的分析')
  assert.ok(clicks.some(selector => String(selector).includes('nth=2')))
})

test('GeminiModels refuses an unavailable mode', async () => {
  const { driver } = driverFixture()
  const models = new GeminiModels({ settings: {}, driver })
  await models.list(true)
  await assert.rejects(
    () => models.select({ modelName: 'Unknown' }),
    error => error.code === 'model-unavailable',
  )
})

test('GeminiModels applies reasoning effort from the selected level', async () => {
  const { driver, clicks } = driverFixture()
  const models = new GeminiModels({ settings: {}, driver })
  const catalog = await models.list(true)
  driver.locator = () => ({
    evaluateAll: () => 1,
    nth: () => ({ click: async () => clicks.push('reasoning:中') }),
  })
  const selected = await models.select({ ...catalog[1], power: 1 })
  assert.equal(selected.power, 1)
  assert.ok(clicks.includes('reasoning:中'))
})

test('Gemini provider advertises mode catalog with stable ids', async () => {
  const { driver } = driverFixture()
  const models = new GeminiModels({ settings: {}, driver })
  const catalog = await models.list(true)
  const adapter = new WebChatAdapter({
    providerId: 'webbridge-gemini', displayName: 'WebBridge · Gemini', modelId: 'gemini-web',
    settings: { site: 'gemini', providers: { contextWindow: 1000000 } },
    siteAuth: () => 'ready', modelCatalog: async () => catalog,
    session: { async ask() { return { reply: 'ok' } } },
  })
  const advertised = await adapter.listModels('webbridge-gemini')
  assert.deepEqual(advertised.map(model => model.id), [
    'gemini-web-mode-0', 'gemini-web-mode-1', 'gemini-web-mode-2',
  ])
  assert.equal(advertised[1].name, '日常帮助')
  assert.equal(advertised[1].context.contextWindow, 1000000)
  assert.deepEqual(advertised[1].reasoning.efforts, [
    { id: 'web-0', name: '低' },
    { id: 'web-1', name: '中' },
    { id: 'web-2', name: '高' },
  ])
})
