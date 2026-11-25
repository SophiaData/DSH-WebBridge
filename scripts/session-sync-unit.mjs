import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ContextStore } from '../src/context.js'
import { createToolScope } from '../src/dsh.js'
import { McpBridge } from '../src/mcp.js'
import { WebChatAdapter } from '../src/provider.js'
import { WebBridgeSetup } from '../src/setup.js'
import { ChatSession } from '../src/session.js'
import { planConversationSync, appendMissingWebTurns, buildConversationReadExpression } from '../src/conversation-sync.js'
import { buildGeminiConversationReadExpression } from '../src/gemini-dom.js'
import { parseSyncRequest } from '../src/setup-contract.js'

test('sync request accepts only an explicit WebBridge session and provider', () => {
  assert.deepEqual(parseSyncRequest({ sessionId: ' session-A ', provider: 'webbridge-chatgpt' }), {
    sessionId: 'session-A', provider: 'webbridge-chatgpt',
  })
  assert.throws(() => parseSyncRequest({ sessionId: '', provider: 'webbridge-chatgpt' }), /sessionId/)
  assert.throws(() => parseSyncRequest({ sessionId: 'session-A', provider: 'other-provider' }), /不是 WebBridge/)
})

test('provider sync reads the existing conversation and preserves the incremental cursor', async () => {
  const calls = []
  const adapter = new WebChatAdapter({
    providerId: 'webbridge-chatgpt',
    displayName: 'ChatGPT',
    modelId: 'chatgpt-web',
    settings: { site: 'chatgpt', providers: {} },
    session: {
      async readConversation(options) {
        calls.push(options)
        return { url: 'https://chatgpt.com/c/abc', messages: [] }
      },
      async newChat() { assert.fail('sync must not create a new chat') },
    },
  })
  adapter.sessionState.set('session-A', {
    bootstrapped: true, contextDelivered: true, sentMessages: 1,
    sentUserKeys: ['old'], toolContext: 'old', contextReference: { context_id: 'old' },
  })

  const result = await adapter.syncSession('session-A')
  assert.deepEqual(calls, [{ site: 'chatgpt', sessionKey: 'session-A' }])
  assert.equal(result.url, 'https://chatgpt.com/c/abc')
  assert.equal(adapter.sessionState.get('session-A').contextReference.context_id, 'old')
  adapter.noteSynchronized('session-A', [
    { role: 'user', source: { kind: 'user' }, id: '1', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', source: { kind: 'user' }, id: '2', content: [{ type: 'text', text: 'missing' }] },
  ])
  assert.equal(adapter.sessionState.get('session-A').sentMessages, 2)
  assert.equal(adapter.sessionState.get('session-A').sentUserKeys.length, 2)
})

test('browser DOM reader extracts both speakers from one rendered chat', () => {
  const url = 'https://chatgpt.com/c/safe-history'
  const assistantNode = {
    nodeType: 1, tagName: 'DIV', childNodes: [{ nodeType: 3, textContent: 'World' }],
    innerText: 'World', checkVisibility: () => true, contains: () => false, getAttribute: () => '',
  }
  const rows = [
    {
      checkVisibility: () => true,
      getAttribute: () => 'conversation:1:user',
      querySelector: () => ({ innerText: 'Hello' }),
    },
    {
      checkVisibility: () => true,
      getAttribute: () => 'conversation:1:assistant',
      querySelectorAll: () => [assistantNode],
      querySelector: () => assistantNode,
    },
  ]
  const result = runInNewContext(buildConversationReadExpression(), {
    location: { href: url },
    document: {
      title: 'One chat',
      querySelectorAll(selector) { return selector.includes('data-content-search-unit-key') ? rows : [] },
    },
  })
  assert.equal(result.url, url)
  assert.deepEqual(Array.from(result.messages, message => [message.role, message.text]), [
    ['user', 'Hello'], ['assistant', 'World'],
  ])
  assert.equal(result.messages[1].markdown, 'World')
})

test('browser reader stays on the mapped URL and does not create a chat', async () => {
  const url = 'https://chatgpt.com/c/mapped-chat'
  const actions = []
  const driver = {
    async exclusive(fn, key) { actions.push(['exclusive', key]); return fn() },
    async getSessionInfo(key) { actions.push(['lookup', key]); return { url } },
    async state() { return { url } },
    async eval(expression) {
      assert.match(expression, /data-content-search-unit-key/)
      return { result: { url, messages: [{ role: 'user', key: '1:user', text: 'Hello' }] } }
    },
    async releasePage(key) { actions.push(['release', key]) },
    async open() { assert.fail('must not navigate away from the active mapped URL') },
  }
  const session = new ChatSession({ settings: { site: 'chatgpt', adapterDir: '/tmp/dsh-webbridge-sync-unit' }, driver })
  const result = await session.readConversation({ sessionKey: 'session-A' })
  assert.equal(result.messages.length, 1)
  assert.deepEqual(actions, [
    ['exclusive', 'chatgpt:session-A'],
    ['lookup', 'chatgpt:session-A'],
    ['release', 'chatgpt:session-A'],
  ])
})

test('sync fills only missing web suffix and remains idempotent', () => {
  const url = 'https://chatgpt.com/c/owned-chat'
  const local = [
    { role: 'user', id: 'a', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', id: 'b', source: { kind: 'model' }, content: [{ type: 'text', text: 'Old answer' }] },
  ]
  const web = [
    { role: 'user', key: '1:user', text: 'Hello' },
    { role: 'assistant', key: '1:assistant', text: 'Old answer' },
    { role: 'user', key: '2:user', text: '调用 Nexus DSH 的 dsh_get_context，参数为 {"context_id":"ctx"}。\n读取所有分页。\n\nNew question' },
    { role: 'assistant', key: '2:assistant', text: 'New answer', markdown: '**New answer**' },
  ]
  const plan = planConversationSync(local, web, url)
  assert.equal(plan.visible, 4)
  assert.equal(plan.matched, 2)
  assert.equal(plan.missing.length, 2)
  assert.equal(plan.missing[0].text, 'New question')
  const records = []
  const session = { append(events) { records.push(...events) } }
  assert.equal(appendMissingWebTurns(session, { lastTurn: 5, openTurnStartSeq: null },
    plan.missing, { provider: 'webbridge-chatgpt', model: 'chatgpt-web' }), 2)
  assert.deepEqual(records.map(event => event[0]), [
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  assert.equal(records[0][1].turn, 6)
  assert.equal(records[3][1].message.content[0].text, '**New answer**')
  assert.equal(records[3][1].message.source.provider, 'webbridge-chatgpt')
  const imported = records.filter(event => event[0] === 'user/message' || event[0] === 'assistant/message')
    .map(event => event[0] === 'user/message' ? event[1] : event[1].message)
  assert.equal(planConversationSync([...local, ...imported], web, url).missing.length, 0)
  assert.throws(() => appendMissingWebTurns(session, { lastTurn: 6, openTurnStartSeq: 12 }, plan.missing,
    { provider: 'webbridge-chatgpt', model: 'chatgpt-web' }), /正在运行/)
})

test('sync strips protocol markers from restored web turns', () => {
  const url = 'https://chatgpt.com/c/marker-chat'
  const local = [
    { role: 'user', id: 'a', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] },
  ]
  const web = [
    { role: 'user', key: '1:user', text: 'Hello' },
    { role: 'assistant', key: '1:assistant', text: '<<< 你好！有什么我可以帮你的吗？ <<<END_FINAL>>>' },
  ]
  const plan = planConversationSync(local, web, url)
  assert.equal(plan.missing.length, 1)
  assert.equal(plan.missing[0].text, '你好！有什么我可以帮你的吗？')
})

test('Gemini conversation reader returns all visible query/response pairs', () => {
  const userNode = text => ({ textContent: text, querySelectorAll: () => [{ textContent: text }] })
  const responseNode = text => ({
    textContent: text,
    innerText: text,
    checkVisibility: () => true,
    querySelector: () => ({
      textContent: text,
      innerText: text,
      cloneNode: () => ({
        nodeType: 1,
        textContent: text,
        childNodes: [],
        querySelectorAll: () => [],
      }),
    }),
  })
  const result = runInNewContext(buildGeminiConversationReadExpression(), {
    location: { href: 'https://gemini.google.com/app/abc' },
    document: {
      title: 'Gemini chat',
      querySelectorAll(selector) {
        if (selector === 'user-query') return [userNode('First'), userNode('Second')]
        if (selector === 'model-response') return [responseNode('Answer one'), responseNode('Answer two')]
        return []
      },
    },
  })
  assert.deepEqual(Array.from(result.messages, message => [message.role, message.text]), [
    ['user', 'First'], ['assistant', 'Answer one'], ['user', 'Second'], ['assistant', 'Answer two'],
  ])
  assert.equal(result.url, 'https://gemini.google.com/app/abc')
})

test('a transport-interrupted assistant reply imports only its missing continuation', () => {
  const prefix = 'This is a sufficiently long assistant answer that was interrupted while streaming.'
  const local = [
    { role: 'user', id: 'local-u', source: { kind: 'user' }, content: [{ type: 'text', text: 'Can you explain?' }] },
    { role: 'assistant', id: 'local-a', source: { kind: 'model' }, content: [{ type: 'text', text: prefix }] },
  ]
  const url = 'https://chatgpt.com/c/recovered'
  const web = [
    { role: 'user', key: '1:user', text: 'Can you explain?' },
    { role: 'assistant', key: '1:assistant', text: prefix + ' The missing final paragraph is now present.' },
  ]
  const planned = planConversationSync(local, web, url)
  assert.equal(planned.missing.length, 1)
  assert.match(planned.missing[0].text, /网页恢复/)
  assert.match(planned.missing[0].text, /missing final paragraph/)
  assert.ok(!planned.missing[0].text.includes(prefix))
  const events = []
  appendMissingWebTurns({ append(batch) { events.push(...batch) } },
    { lastTurn: 1, openTurnStartSeq: null }, planned.missing,
    { provider: 'webbridge-chatgpt', model: 'chatgpt-web' })
  const imported = events.find(event => event[0] === 'assistant/message')[1].message
  assert.equal(planConversationSync([...local, imported], web, url).missing.length, 0)
})

test('DSH maintenance prevents writes during a turn and flushes on success', async () => {
  let busy = false
  let flushes = 0
  const session = { deriveMessages: () => [], append: () => {} }
  const agent = {
    id: 'session-A', session, status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    async runMaintenance(fn) { return fn(new AbortController().signal) },
  }
  const listeners = new Map()
  const ctx = {
    inject(names, callback) {
      const available = {
        agents: { list: () => [agent], turnBoundaryOf: () => ({ lastTurn: 3, openTurnStartSeq: null }) },
        sessions: { async flush() { flushes++ } },
        attachments: {}, workingDirectory: {},
      }
      callback(Object.fromEntries(names.map(name => [name, available[name]])))
    },
    on(name, callback) { listeners.set(name, callback) },
  }
  const scope = createToolScope(ctx)
  const result = await scope.withSessionMaintenance('session-A', ({ session: selected, boundary }) => {
    assert.equal(selected, session)
    assert.equal(boundary.lastTurn, 3)
    return 'repaired'
  })
  assert.equal(result, 'repaired')
  assert.equal(flushes, 1)
  agent.status = 'running'
  await assert.rejects(scope.withSessionMaintenance('session-A', () => {
    busy = true
  }), /正在运行/)
  assert.equal(busy, false)
})

test('sync refuses an unrelated conversation rather than merging it', () => {
  const local = [{ role: 'user', id: 'a', source: { kind: 'user' }, content: [{ type: 'text', text: 'Local only' }] }]
  const web = [{ role: 'user', key: 'z:user', text: 'Some other chat' }]
  assert.throws(() => planConversationSync(local, web, 'https://chatgpt.com/c/another'), /无法对应/)
  assert.throws(() => planConversationSync(local, [], 'https://chatgpt.com/c/another'), /没有可读取/)
})

test('tool-scope sync reset expires old DSH context and refuses an active request', async () => {
  const contextStore = new ContextStore()
  const listeners = new Map()
  const ctx = {
    inject(services, callback) {
      const available = {
        agents: { list: () => [] },
        attachments: {},
        workingDirectory: {},
      }
      callback(Object.fromEntries(services.map(name => [name, available[name]])))
    },
    on(name, callback) { listeners.set(name, callback) },
    tools: { schemas: () => [] },
  }
  const scope = createToolScope(ctx, () => {}, { contextStore })
  const reference = contextStore.capture({ sessionId: 'session-A', messages: [] })
  assert.equal(contextStore.has(reference.context_id), true)

  await scope.withSession('session-A', async () => {
    assert.throws(() => scope.resetSession('session-A'), error => error.code === 'session-busy')
  })

  const result = scope.resetSession('session-A')
  assert.equal(result.contextCleared, true)
  assert.equal(contextStore.has(reference.context_id), false)
})

test('MCP sync clears only bindings for the selected DSH session', () => {
  const bridge = new McpBridge({
    ctx: { tools: { schemas: () => [] } },
    settings: { stateDir: '', mcp: { allowTools: [] } },
    ops: {},
  })
  bridge.sessions.set('mcp-A', { id: 'mcp-A', dshSessionId: 'session-A', contextId: 'ctx-A', lastActive: 1 })
  bridge.sessions.set('mcp-B', { id: 'mcp-B', dshSessionId: 'session-B', contextId: 'ctx-B', lastActive: 1 })

  const result = bridge.resetSessionBinding('session-A')
  assert.equal(result.bindingsReset, 1)
  assert.equal(bridge.sessions.get('mcp-A').dshSessionId, null)
  assert.equal(bridge.sessions.get('mcp-A').contextId, null)
  assert.equal(bridge.sessions.get('mcp-B').dshSessionId, 'session-B')
})

test('setup sync remote delegates the validated request', async () => {
  const received = []
  const setup = new WebBridgeSetup({
    settings: {},
    driver: {},
    bridge: { status: () => ({ exposed: { dsh: [] } }) },
    tunnel: { status: () => ({}) },
    browser: { auth: {}, saved: {} },
    syncSession: async request => { received.push(request); return { ok: true, ...request } },
  })
  const result = await setup.sync({ sessionId: 'session-A', provider: 'webbridge-chatgpt' })
  assert.deepEqual(received, [{ sessionId: 'session-A', provider: 'webbridge-chatgpt' }])
  assert.equal(result.ok, true)
})

test('client registers the sync control beside the model picker and loads model selection support', async () => {
  const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const built = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const source of [client, built]) {
    assert.match(source, /conversation\.input\.right/)
    assert.match(source, /webbridge-session-sync/)
    assert.match(source, /provider\.startsWith\('webbridge-'\)/)
    assert.match(source, /remote\.webbridgeSetup\.sync/)
  }
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-model-selection'))
})

test('built client renders sync only for WebBridge models and routes the current session id', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let contribution
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { contribution = value } } } })
  assert.equal(contribution.id, '@local/dsh-webbridge')

  const states = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) { const state = typeof initial === 'function' ? initial() : initial; states.push(state); return [state, () => {}] },
    useEffect(effect) { effect() },
    useRef(value) { return { current: value } },
  }
  const module = contribution.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected browser dependency: ${name}`)
  })
  let provider = 'webbridge-chatgpt'
  const syncCalls = []
  const registrations = []
  const store = {
    subscribe() { return () => {} },
    getSnapshot() { return { current: { provider } } },
  }
  const slots = {
    inject(_name, callback) { callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  }
  const uiScope = {
    slots,
    modelDirectories: { directoryFor: () => ({ store, async load() {} }) },
  }
  const remote = {
    $mount: async () => {},
    webbridgeSetup: {
      read: async () => ({ ok: true, value: {} }),
      execute: async () => ({ ok: true, value: {} }),
      debug: async () => ({ ok: true, value: {} }),
      sync: async request => { syncCalls.push(request); return { ok: true, value: { synced: true } } },
    },
  }
  const scope = {
    remote, slots,
    inject(services, callback) { if (services.includes('modelDirectories')) callback(uiScope) },
  }
  const ctx = {
    remote, slots,
    effect(callback) { callback() },
    inject(services, callback) { if (services.includes('remote.webbridgeSetup')) callback(scope) },
  }
  module.apply(ctx)
  const registration = registrations.find(entry => entry.options.id === 'webbridge-session-sync')
  assert.ok(registration)
  assert.equal(registration.options.name, 'conversation.input.right')
  assert.equal(registration.options.order, -1000)

  const props = registration.options.inject('session-current')
  const rendered = registration.component(props)
  assert.ok(rendered)
  const findButton = node => !node || typeof node !== 'object' ? null
    : node.type === 'button' ? node
      : (node.children || []).map(findButton).find(Boolean) || null
  const button = findButton(rendered)
  assert.ok(button)
  assert.equal(button.props['aria-label'], '同步网页会话')
  await button.props.onClick()
  assert.equal(syncCalls.length, 1)
  assert.equal(syncCalls[0].sessionId, 'session-current')
  assert.equal(syncCalls[0].provider, 'webbridge-chatgpt')

  provider = 'other-provider'
  assert.equal(registration.component(props), null)
})
