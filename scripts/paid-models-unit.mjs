import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebChatAdapter } from '../src/provider.js'
import { ChatgptModels, paidModelKey } from '../src/models/chatgpt.js'

const choice = (name, power, label) => ({ key: paidModelKey(name, power), modelName: name, power, label })
function fixture(catalog, tier = 'paid') {
  const sent = []
  const adapter = new WebChatAdapter({ providerId: 'webbridge-chatgpt', displayName: 'ChatGPT 网页版', modelId: 'chatgpt-web', settings: { site: 'chatgpt', providers: {} }, accountTier: async () => tier, modelCatalog: async () => catalog.current,
    session: { async ask(_text, options) { sent.push(options); return { reply: 'ok' } } } })
  return { adapter, sent }
}
const consume = async stream => { for await (const _chunk of stream) {} }

test('paid models are advertised from the discovered catalog, not a fixed model/effort list', async () => {
  const catalog = { current: [choice('Model from account A', 0, 'Instant'), choice('Model from account B', 3, 'Custom effort')] }
  const { adapter, sent } = fixture(catalog)
  const models = await adapter.listModels('webbridge-chatgpt')
  assert.equal(models.length, 2)
  assert.equal(models[1].name, 'Model from account B')
  assert.deepEqual(models[1].reasoning.efforts, [{ id: 'web-3', name: 'Custom effort' }])
  await consume(adapter.generate({ model: models[1].id, sessionId: 'paid', messages: [{ role: 'user', content: 'hi' }] }))
  assert.deepEqual(sent[0].webModel, catalog.current[1])
  assert.equal(sent[0].reasoning, undefined)
  catalog.current = [choice('New account model', 1, 'New level')]
  assert.equal((await adapter.listModels('webbridge-chatgpt'))[0].name, 'New account model')
})

test('free accounts retain exactly the existing thinking and non-thinking choices', async () => {
  const { adapter, sent } = fixture({ current: [choice('Stale paid model', 4, 'Pro')] }, 'free')
  const models = await adapter.listModels('webbridge-chatgpt')
  assert.deepEqual(models.map(model => model.id), ['chatgpt-web', 'chatgpt-web-instant'])
  for (const model of models) await consume(adapter.generate({ model: model.id, messages: [{ role: 'user', content: 'hi' }] }))
  assert.deepEqual(sent.map(options => options.reasoning), ['on', 'off'])
})

test('prepared calls bind selection and metadata to the same catalog generation', async () => {
  const catalog = { current: [choice('Prepared model', 2, 'Deep')] }
  const { adapter, sent } = fixture(catalog)
  const id = `chatgpt-web-${catalog.current[0].key}`
  const prepared = await adapter.prepareCall('webbridge-chatgpt', id)
  catalog.current = []
  await consume(prepared.stream({ model: 'ignored-other-model', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(prepared.model.name, 'Prepared model')
  assert.equal(sent[0].webModel.modelName, 'Prepared model')
})

test('the native reasoning control selects a level without duplicating model rows', async () => {
  const catalog = { current: [choice('One model', 0, 'Instant'), choice('One model', 2, 'Deep')] }
  const { adapter, sent } = fixture(catalog)
  const models = await adapter.listModels('webbridge-chatgpt')
  assert.equal(models.length, 1)
  await consume(adapter.generate({ model: models[0].id, reasoningEffort: 'web-2', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(sent[0].webModel.power, 2)
})

test('removed paid choices fail before submitting user text', async () => {
  const { adapter, sent } = fixture({ current: [] })
  await assert.rejects(() => consume(adapter.generate({ model: 'chatgpt-web-paid-missing-4', messages: [{ role: 'user', content: 'hi' }] })), error => error.code === 'model-unavailable')
  assert.equal(sent.length, 0)
})

test('cancelling metadata resolution does not wait for a slow browser catalog', async () => {
  const { adapter } = fixture({ current: [] })
  adapter.modelCatalog = () => new Promise(() => {})
  const abort = new AbortController()
  const pending = adapter.prepareCall('webbridge-chatgpt', 'chatgpt-web-paid-delayed-1', abort.signal)
  abort.abort(new Error('cancelled catalog lookup'))
  await assert.rejects(pending, /cancelled catalog lookup/)
})

test('a Cloudflare challenge during model selection asks for verification instead of claiming the page changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-model-challenge-'))
  try {
    const page = {
      url: () => 'https://chatgpt.com/c/challenged',
      evaluate: async () => true,
      locator: () => { const chain = { filter: () => chain, first: () => chain, count: async () => 0 }; return chain },
    }
    const driver = {
      currentPage: async () => page,
      state: async () => ({ url: 'https://chatgpt.com/c/challenged', manualAuth: { required: false } }),
    }
    const models = new ChatgptModels({ settings: { stateDir: root, modelTriggerTimeoutMs: 100 }, driver })
    await assert.rejects(() => models.trigger(), error => error.code === 'auth-required:verification' && error.details?.headed === true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('localized effort labels do not fail model selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-model-locale-'))
  try {
    const driver = { currentPage: async () => ({ keyboard: { press: async () => {} } }) }
    const models = new ChatgptModels({ settings: { stateDir: root }, driver })
    models.chooseModel = async () => {}
    models.power = async () => {}
    models.read = async () => ({ modelName: 'GPT-6', power: 2, label: '高', effort: 'high' })
    const selected = await models.select({ modelName: 'GPT-6', power: 2, label: 'High', effort: 'high' })
    assert.equal(selected.label, '高')
    models.read = async () => ({ modelName: 'GPT-6', power: 2, label: 'High', effort: 'medium' })
    await assert.rejects(() => models.select({ modelName: 'GPT-6', power: 2, label: 'High', effort: 'high' }), error => error.code === 'model-not-selected')
  } finally { await rm(root, { recursive: true, force: true }) }
})
