/** Gemini web provider: hermetic protocol/turn tests, no Google account required. */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { parseGeminiReply } from '../src/gemini-protocol.js'
import { WebChatAdapter } from '../src/provider.js'
import { buildReadExpression } from '../src/adapters.js'
import { resolveSettings, SITE_PRESETS, visibleSites } from '../src/config.js'
import { ChatSession, persistedConversationURL } from '../src/session.js'
import { waitForReply } from '../src/detect.js'

const user = text => ({ role: 'user', source: { kind: 'user' }, content: text })
const tool = { name: 'read', description: 'Read one approved file', parameters: { path: { type: 'string', required: true } } }
const calls = (name = 'read', args = { path: 'a.txt' }) =>
  '<<<TOOL_CALLS>>>' + JSON.stringify([{ name, arguments: args }]) + '<<<END_TOOL_CALLS>>>'

async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function providerFixture(responses, overrides = {}) {
  const sent = []
  const adapter = new WebChatAdapter({
    providerId: 'webbridge-gemini',
    displayName: 'WebBridge · Gemini',
    modelId: 'gemini-web',
    settings: { site: 'gemini', providers: { maxPromptChars: 32000 } },
    session: { ask: async (message, opts) => {
      sent.push({ message, ...opts })
      return { reply: responses[Math.min(sent.length - 1, responses.length - 1)] }
    } },
    parseReply: parseGeminiReply,
    siteAuth: () => 'ready',
    accountTier: async () => 'unknown',
    ...overrides,
  })
  return { adapter, sent }
}

test('Gemini is visible by default but absent from the catalog until login is ready', async () => {
  assert.deepEqual(visibleSites(resolveSettings({})), ['chatgpt', 'gemini'])
  const { adapter } = providerFixture(['ok'], { siteAuth: () => 'needs-login' })
  assert.deepEqual(await adapter.listModels('webbridge-gemini'), [])
  const ready = providerFixture(['ok'])
  const models = await ready.adapter.listModels('webbridge-gemini')
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'gemini-web')
})

test('Gemini parser only accepts explicit complete protocol tool calls', () => {
  assert.deepEqual(parseGeminiReply(calls()), { kind: 'calls', calls: [{ name: 'read', arguments: { path: 'a.txt' } }] })
  assert.deepEqual(parseGeminiReply('<<<FINAL>>>Done<<<END_FINAL>>>'), { kind: 'final', text: 'Done' })
  assert.deepEqual(parseGeminiReply('<<< 你好！有什么我可以帮你的吗？ <<<END_FINAL>>>'), { kind: 'final', text: '你好！有什么我可以帮你的吗？' })
  assert.deepEqual(parseGeminiReply('Text and ```json\n{"name":"read","arguments":{}}\n```'), { kind: 'text', text: 'Text and ```json\n{"name":"read","arguments":{}}\n```' })
  assert.deepEqual(parseGeminiReply('x ' + calls()), { kind: 'text', text: 'x ' + calls() })
  for (const text of ['<<<TOOL_CALLS>>>[{"name":"read"', '<<<TOOL_CALLS>>>not-json<<<END_TOOL_CALLS>>>', calls('read', []), calls('read', null), calls('invalid name', {})]) {
    assert.throws(() => parseGeminiReply(text), /gemini-tool-protocol/)
  }
})

test('Gemini tool call emits native DSH tool-call chunks and rejects missing permissions', async () => {
  const { adapter, sent } = providerFixture([calls()])
  const chunks = await collect(adapter, { sessionId: 'gemini-tools', messages: [user('Read a.txt')], tools: [tool] })
  assert.equal(chunks.at(-1).reason.kind, 'tool-use')
  assert.equal(chunks.find(item => item.type === 'block-end').block.name, 'read')
  assert.match(sent[0].message, /<<<NEXUS_TOOLS>>>/)
  assert.match(sent[0].message, /Read a\.txt/)
  assert.equal(sent[0].attachment, null)
  const blocked = providerFixture([calls('bash', { command: 'whoami' })])
  await assert.rejects(collect(blocked.adapter, { sessionId: 'gemini-deny', messages: [user('Read a.txt')], tools: [tool] }), error => error.code === 'tool-not-allowed')
})

test('Gemini follows up using only newly returned DSH tool results', async () => {
  const { adapter, sent } = providerFixture([calls(), '<<<FINAL>>>FILE_READ<<<END_FINAL>>>'])
  const messages = [user('Read a.txt')]
  const first = await collect(adapter, { sessionId: 'tool-followup', messages, tools: [tool] })
  const block = first.find(item => item.type === 'block-end').block
  messages.push({ role: 'assistant', content: [block] })
  messages.push({ role: 'tool', content: [{ type: 'tool-result', name: 'read', result: { text: 'FILE_READ' } }] })
  const second = await collect(adapter, { sessionId: 'tool-followup', messages, tools: [tool] })
  assert.match(sent[1].message, /FILE_READ/)
  assert.doesNotMatch(sent[1].message, /<<<NEXUS_TOOLS>>>|Read a\.txt/)
  assert.equal(second.filter(item => item.type === 'text-delta').map(item => item.text).join(''), 'FILE_READ')
})

function geminiPage({ userText = 'Hello', replies = ['Old answer'], stopping = false } = {}) {
  const visible = () => true
  const child = text => ({ nodeType: 3, textContent: text })
  const contents = replies.map(answer => {
    const content = {
      nodeType: 1, tagName: 'DIV', childNodes: [child(answer)],
      textContent: answer, innerText: answer,
      cloneNode() { return { ...this, childNodes: [child(answer)] } },
      querySelectorAll() { return [] },
      getAttribute() { return null },
    }
    return { checkVisibility: visible, querySelector: () => content, getAttribute: () => null }
  })
  const users = [{ checkVisibility: visible, querySelectorAll: () => [{ textContent: userText }], textContent: userText, getAttribute: () => null }]
  const stop = [{ checkVisibility: visible }]
  const document = { querySelectorAll(selector) {
    if (selector === 'model-response') return contents
    if (selector === 'user-query') return users
    if (selector.includes('stop-button')) return stopping ? stop : []
    return []
  } }
  return { document, location: { href: 'https://gemini.google.com/app/test' } }
}

test('Gemini DOM reader returns one answer per model-response, ignores nested thought nodes', () => {
  const expression = buildReadExpression({ ...SITE_PRESETS.gemini.adapter, site: 'gemini' })
  const first = vm.runInNewContext(expression, geminiPage({ replies: ['Old', 'Latest'], stopping: false }))
  assert.equal(first.count, 2)
  assert.equal(first.text, 'Latest')
  assert.equal(first.userText, 'Hello')
  assert.equal(first.streaming, false)
  const busy = vm.runInNewContext(expression, geminiPage({ replies: ['Partial'], stopping: true }))
  assert.equal(busy.streaming, true)
  assert.equal(busy.completed, false)
})

test('Gemini DOM identity changes when a virtualized response node is replaced', () => {
  const expression = buildReadExpression({ ...SITE_PRESETS.gemini.adapter, site: 'gemini' })
  const page = geminiPage({ replies: ['OK'] })
  const first = vm.runInNewContext(expression, page)
  const again = vm.runInNewContext(expression, page)
  assert.ok(first.replyId)
  assert.equal(again.replyId, first.replyId, 'same DOM node keeps its identity')
  const replacement = geminiPage({ replies: ['OK'] }).document.querySelectorAll('model-response')[0]
  const getOriginal = page.document.querySelectorAll.bind(page.document)
  page.document.querySelectorAll = selector =>
    selector === 'model-response' ? [replacement] : getOriginal(selector)
  const next = vm.runInNewContext(expression, page)
  assert.equal(next.text, first.text)
  assert.equal(next.count, first.count)
  assert.notEqual(next.replyId, first.replyId, 'virtualized answer replacement is recognized')
})

test('Gemini confirms a submitted user-query before response generation without resending', async () => {
  let draft = 'Hello'
  const newTurn = { count: 1, text: 'Old answer', url: 'https://gemini.google.com/app/1',
    userTurnKey: 'gemini-q-2', userText: 'Hello', streaming: false }
  const driver = { eval: async expression => expression.includes('composerText')
    ? { result: { composerCount: 1, composerText: draft } }
    : { result: newTurn } }
  const settings = resolveSettings({ site: 'gemini', stateDir: '' })
  const session = new ChatSession({ settings, driver })
  const baseline = { count: 1, text: 'Old answer', userTurnKey: 'gemini-q-1' }
  const observed = await session.readSubmission('Hello', { ...SITE_PRESETS.gemini.adapter, site: 'gemini' }, baseline)
  assert.equal(observed.sent?.userTurnKey, 'gemini-q-2')
})

test('Gemini /app conversation route is persisted; /app itself is not', async () => {
  const root = 'https://gemini.google.com/app'
  assert.equal(persistedConversationURL('gemini', root, root), false)
  assert.equal(persistedConversationURL('gemini', root + '/abc_123', root), true)
  assert.equal(persistedConversationURL('gemini', root + '/abc_123?hl=zh-cn', root), true)
  assert.equal(persistedConversationURL('gemini', 'https://attacker.example/app/abc_123', root), false)
  assert.equal(persistedConversationURL('chatgpt', 'https://chatgpt.com/c/abc', 'https://chatgpt.com/'), true)
  assert.equal(persistedConversationURL('chatgpt', 'https://chatgpt.com/c/local-chatgpt', 'https://chatgpt.com/'), false)

  const opened = []
  const session = new ChatSession({ settings: resolveSettings({ site: 'gemini' }), driver: {
    async open(url) { opened.push(url) },
  } })
  session.waitBlank = async () => true
  assert.equal(await session.startNewChat('gemini'), 'gemini-app')
  assert.deepEqual(opened, [root])
})

test('Gemini waits for a new response instead of returning the previous turn', async () => {
  const old = { count: 1, text: 'Old answer', streaming: false, completed: true,
    generationKnown: true, userTurnKey: 'gemini-q-1', userText: 'Before' }
  const submitted = { ...old, userTurnKey: 'gemini-q-2', userText: 'Hello' }
  const latest = { ...submitted, text: 'New answer' }
  const states = [submitted, submitted, latest, latest, latest]
  let at = 0
  const driver = { async eval() { return { result: states[Math.min(at++, states.length - 1)] } } }
  const result = await waitForReply({
    driver,
    adapter: { ...SITE_PRESETS.gemini.adapter, site: 'gemini' },
    baseline: old,
    expectedText: 'Hello',
    expectedTurnKey: 'gemini-q-2',
    settings: { replyTimeoutMs: 500, pollIntervalMs: 1, stableSamples: 1, stateDir: '' },
  })
  assert.equal(result.text, 'New answer')
  assert.ok(at >= 4)
})

test('Gemini regular replies stream before the browser exchange finishes', async () => {
  let finish
  const adapter = providerFixture([], {
    session: { async ask(_message, options) {
      options.onProgress?.({ text: 'Hello' })
      await new Promise(resolve => { finish = resolve })
      return { reply: 'Hello world' }
    } },
  }).adapter
  const chunks = adapter.stream({ sessionId: 'gemini-stream', messages: [user('Say hello')] })[Symbol.asyncIterator]()
  assert.deepEqual(await chunks.next(), { value: { type: 'block-start', index: 0, blockType: 'text' }, done: false })
  assert.deepEqual(await chunks.next(), { value: { type: 'text-delta', index: 0, text: 'Hello' }, done: false })
  finish()
  const rest = []
  for await (const chunk of { [Symbol.asyncIterator]: () => chunks }) rest.push(chunk)
  assert.equal(rest.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), ' world')
  assert.equal(rest.at(-1).reason.kind, 'stop')
})

test('Gemini tool envelopes never leak partial text before native tool chunks', async () => {
  const { adapter } = providerFixture([], {
    session: { async ask(_message, options) {
      options.onProgress?.({ text: '<<<' })
      options.onProgress?.({ text: calls() })
      return { reply: calls() }
    } },
  })
  const chunks = await collect(adapter, { sessionId: 'gemini-stream-call', messages: [user('Read a.txt')], tools: [tool] })
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 0)
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.name, 'read')
})

test('Gemini must not turn already-streamed narrative into executable tool calls', async () => {
  const { adapter } = providerFixture([], {
    session: { async ask(_message, options) {
      options.onProgress?.({ text: 'Let me check.' })
      return { reply: calls() }
    } },
  })
  const stream = adapter.stream({ sessionId: 'protocol-conflict', messages: [user('Read a.txt')], tools: [tool] })
  const iterator = stream[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, 'block-start')
  assert.equal((await iterator.next()).value.text, 'Let me check.')
  await assert.rejects(iterator.next(), error => error.code === 'gemini-tool-protocol-conflict')
})

test('Gemini never resends an already submitted turn after reply failure', async () => {
  const { adapter, sent } = providerFixture(['First answer', 'Second answer'])
  const initial = [user('question')]
  await collect(adapter, { sessionId: 'submitted-turn', messages: initial, tools: [tool] })
  assert.equal(sent.length, 1)
  await assert.rejects(
    collect(adapter, { sessionId: 'submitted-turn', messages: initial, tools: [tool] }),
    error => error.code === 'gemini-turn-already-submitted',
  )
  assert.equal(sent.length, 1, 'same request must not be sent a second time')
  await collect(adapter, { sessionId: 'submitted-turn', messages: [...initial, user('new question')], tools: [tool] })
  assert.equal(sent.length, 2)
})

test('Gemini does not trust draft disappearing without an actual new user-query', async () => {
  const previous = { count: 1, text: 'Old', streaming: true,
    userTurnKey: 'gemini-q-1', userText: 'Old question' }
  const driver = { eval: async expression => expression.includes('composerText')
    ? { result: { composerCount: 1, composerText: '' } }
    : { result: previous } }
  const session = new ChatSession({ settings: resolveSettings({ site: 'gemini' }), driver })
  const result = await session.readSubmission('New question', {
    ...SITE_PRESETS.gemini.adapter, site: 'gemini',
  }, { ...previous, streaming: false })
  assert.equal(result.sent, undefined)
})

test('Gemini can finish an identical response when the model-response DOM identity changed', async () => {
  const baseline = { count: 1, text: 'OK', replyId: 'gemini-model-1', replyTurnKey: 'gemini-r-1',
    userTurnKey: 'gemini-q-1', userText: 'Before', completed: true, generationKnown: true, streaming: false }
  const current = { ...baseline, replyId: 'gemini-model-2', userTurnKey: 'gemini-q-2', userText: 'Again' }
  const driver = { eval: async () => ({ result: current }) }
  const reply = await waitForReply({
    driver, adapter: { ...SITE_PRESETS.gemini.adapter, site: 'gemini' },
    baseline, expectedText: 'Again',
    settings: { replyTimeoutMs: 30, pollIntervalMs: 1, stableSamples: 1, stateDir: '' },
  })
  assert.equal(reply.text, 'OK')
})

test('Gemini only accepts an unchanged response after the new request was seen streaming', async () => {
  const baseline = { count: 1, text: 'OK', replyId: 'gemini-model-1',
    userTurnKey: 'gemini-q-1', userText: 'Before', completed: true, generationKnown: true, streaming: false }
  const current = { ...baseline, userTurnKey: 'gemini-q-2', userText: 'Again' }
  const states = [{ ...current, streaming: true, completed: false }, current, current, current]
  let reads = 0
  const driver = { eval: async () => ({ result: states[Math.min(reads++, states.length - 1)] }) }
  const reply = await waitForReply({
    driver, adapter: { ...SITE_PRESETS.gemini.adapter, site: 'gemini' },
    baseline, expectedText: 'Again',
    settings: { replyTimeoutMs: 40, pollIntervalMs: 1, stableSamples: 1, stateDir: '' },
  })
  assert.equal(reply.text, 'OK')
})

test('Gemini has finite detection timeout even if global replyTimeoutMs is disabled', async () => {
  const baseline = { count: 1, text: 'Old', replyId: 'gemini-model-1',
    userTurnKey: 'gemini-q-1', userText: 'Before', completed: true, generationKnown: true, streaming: false }
  const stale = { ...baseline, userTurnKey: 'gemini-q-2', userText: 'Again' }
  const driver = { eval: async () => ({ result: stale }) }
  await assert.rejects(waitForReply({
    driver, adapter: { ...SITE_PRESETS.gemini.adapter, site: 'gemini' },
    baseline, expectedText: 'Again',
    settings: { replyTimeoutMs: 0, geminiReplyTimeoutMs: 20, pollIntervalMs: 1, stableSamples: 1, stateDir: '' },
  }), error => error.code === 'reply-timeout')
})
