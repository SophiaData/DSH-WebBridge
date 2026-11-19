/** ChatGPT conversation tests using an in-memory browser. No live account is used. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSettings, SITE_PRESETS } from '../src/config.js'
import { ChatSession } from '../src/session.js'
import { WebChatAdapter } from '../src/provider.js'

function fixture({ initialUrl = 'https://chatgpt.com/c/previous', customNewChatButton = false, rejectSubmission = false, withPlugin = false } = {}) {
  const previous = 'https://chatgpt.com/c/previous'
  const root = 'https://chatgpt.com/'
  const threads = new Map([[previous, ['old reply']]])
  const submitted = []
  let currentUrl = initialUrl
  let pendingText = ''
  let nextThread = 0
  const keys = []
  const clicked = []
  const filled = []
  const opened = []
  const logs = []
  let pluginSelected = false
  let attachment = null
  const startNewChat = () => { currentUrl = root; pluginSelected = false; attachment = null }
  const submitPending = () => {
    if (rejectSubmission) return
    if (currentUrl === root) {
      currentUrl = `${root}c/unit-${++nextThread}`
      threads.set(currentUrl, [])
    }
    threads.get(currentUrl).push(pendingText)
    submitted.push({ url: currentUrl, text: pendingText, plugin: pluginSelected, attachment })
    pendingText = ''
    attachment = null
  }
  const driver = {
    async state() { return { url: currentUrl, title: 'ChatGPT', manualAuth: { required: false } } },
    async open(url) {
      opened.push(url)
      // ChatGPT restores the previous conversation when its root is reopened.
      currentUrl = url === root ? previous : url
      return this.state()
    },
    async click(selector) {
      clicked.push(selector)
      if (selector === SITE_PRESETS.chatgpt.adapter.sendSelector) return submitPending()
      if (selector === 'button[data-testid="composer-plus-btn"], form button:has(svg use[href*="plus"])') return
      if (selector === 'button[data-plugin-impression-id]:has-text("WebBridge DSH")') { pluginSelected = true; return }
      if (customNewChatButton && selector === 'button[data-new-chat]') return startNewChat()
      throw new Error('sidebar control is hidden')
    },
    async fillLong(_selector, text) { filled.push(text); pendingText = text; pluginSelected = false },
    async attachTextFile(name, content) { attachment = { name, content }; return { ok: true } },
    async press(key) {
      keys.push(key)
      if (key === (process.platform === 'darwin' ? 'Meta+Shift+KeyO' : 'Control+Shift+KeyO')) {
        if (customNewChatButton) throw new Error('shortcut unavailable')
        if (currentUrl.startsWith(root)) startNewChat()
      } else if (key === 'Enter') {
        return submitPending()
      }
    },
    async eval(expression) {
      if (expression.includes('pluginSelected')) return { result: { pluginSelected } }
      if (expression.includes('composerText')) return { result: { composerCount: 1, composerText: pendingText } }
      const replies = threads.get(currentUrl) || []
      const turn = replies.length ? `${currentUrl}:turn-${replies.length}` : ''
      return { result: { count: replies.length, text: replies.at(-1) || '', streaming: false, url: currentUrl,
        userTurnKey: turn, userText: replies.at(-1) || '', replyTurnKey: turn, replyId: turn } }
    },
  }
  const settings = resolveSettings({ site: 'chatgpt', stateDir: '', replyTimeoutMs: 1000, commandTimeoutMs: 30, pollIntervalMs: 1, stableSamples: 1 })
  const session = new ChatSession({ settings, driver, log: message => logs.push(message) })
  session.adapter = () => ({
    ...SITE_PRESETS.chatgpt.adapter,
    pluginName: withPlugin ? 'WebBridge DSH' : '',
    ...(customNewChatButton ? { newChatSelector: 'button[data-new-chat]' } : {}),
  })
  const provider = new WebChatAdapter({
    providerId: 'webbridge-chatgpt', displayName: 'ChatGPT', modelId: 'chatgpt-web',
    settings: { providers: {} }, session,
  })
  return { session, provider, driver, submitted, previous, keys, clicked, filled, opened, logs }
}

async function send(provider, sessionId, content) {
  let text = ''
  for await (const chunk of provider.stream({ sessionId, messages: [{ role: 'user', content }] })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

test('one trace follows input, element waits, reply detection and DSH output without recording content', async () => {
  const { provider } = fixture()
  const records = []
  provider.log = line => { if (line.startsWith('[webbridge:flow] {')) records.push(JSON.parse(line.slice('[webbridge:flow] '.length))) }
  await send(provider, 'trace-session', 'PRIVATE_USER_MESSAGE')
  const events = records.map(record => record.event)
  for (const event of ['input.received', 'context.prepared', 'request.queued', 'page.ready', 'input.waiting', 'input.filled', 'send.waiting', 'send.clicked', 'send.confirmed', 'reply.listening', 'reply.settling', 'reply.completed', 'reply.captured', 'request.released', 'output.started', 'output.finished']) {
    assert.ok(events.includes(event), event)
  }
  assert.equal(new Set(records.map(record => record.requestId)).size, 1)
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_USER_MESSAGE/)
  assert.equal(records.at(-1).reason, 'stop')
})

test('ChatGPT sessions get distinct conversations and resume their original conversation', async () => {
  const { provider, session, submitted, previous } = fixture()
  assert.match(await send(provider, 'A', '苹果'), /苹果/)
  const urlA = session.conversations.get('chatgpt:A')?.url
  assert.notEqual(urlA, previous)
  assert.match(await send(provider, 'B', '香蕉'), /香蕉/)
  const urlB = session.conversations.get('chatgpt:B')?.url
  assert.ok(urlA && urlB && urlA !== urlB)
  assert.match(await send(provider, 'A', '继续苹果'), /继续苹果/)
  assert.equal(submitted[2].url, urlA)
  assert.equal(session.conversations.get('chatgpt:A')?.url, urlA)
})

test('a successful DSH round keeps its browser page for the next turn while failures still release it', async () => {
  const { session } = fixture()
  const released = []
  session.driver.releasePage = async key => { released.push(key) }
  await session.ask('完成后保留页面', { sessionKey: 'task-A' })
  assert.deepEqual(released, [])
  assert.ok(session.conversations.get('chatgpt:task-A').url)
  session.driver.fillLong = async () => { throw new Error('composer vanished') }
  await assert.rejects(session.ask('第二轮', { sessionKey: 'task-A' }))
  assert.deepEqual(released, ['chatgpt:task-A'])
})

test('a first ChatGPT request starts a new conversation when another site was active', async () => {
  const { provider, session, previous } = fixture({ initialUrl: 'https://example.com/' })
  assert.match(await send(provider, 'from-other-site', '苹果'), /苹果/)
  const url = session.conversations.get('chatgpt:from-other-site')?.url
  assert.ok(url?.startsWith('https://chatgpt.com/c/'))
  assert.notEqual(url, previous)
})

test('ChatGPT can start a conversation with a calibrated new-chat button', async () => {
  const { provider, session, previous } = fixture({ customNewChatButton: true })
  await send(provider, 'custom-button', '苹果')
  const url = session.conversations.get('chatgpt:custom-button')?.url
  assert.ok(url)
  assert.notEqual(url, previous)
})

test('unkeyed ChatSession calls preserve the current ChatGPT conversation', async () => {
  const { session, submitted, previous } = fixture()
  await session.ask('第一句')
  await session.ask('第二句')
  assert.equal(session.conversations.size, 0)
  assert.deepEqual(submitted.map((entry) => entry.url), [previous, previous])
})

test('legacy ChatGPT calibration still submits with the visible send button', async () => {
  const { session, submitted, clicked, keys } = fixture()
  const adapter = session.adapter()
  session.adapter = () => ({ ...adapter, sendSelector: '' })
  await session.ask('MESSAGE_WITH_ATTACHMENT', { attachment: { name: 'context.txt', content: 'system context' } })
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].text, 'MESSAGE_WITH_ATTACHMENT')
  assert.ok(clicked.includes(SITE_PRESETS.chatgpt.adapter.sendSelector))
  assert.ok(!keys.includes('Enter'))
})

test('a failed submission reports the draft staying in the composer without waiting for a reply', async () => {
  const { session, submitted, clicked } = fixture({ rejectSubmission: true })
  await assert.rejects(session.ask('UNSENT_MESSAGE'), (error) => error.code === 'message-not-sent' && error.details.attempts === 3)
  assert.equal(submitted.length, 0)
  assert.equal(clicked.filter(selector => selector === SITE_PRESETS.chatgpt.adapter.sendSelector).length, 3)
})

const timeout = message => Object.assign(new Error(message), { name: 'TimeoutError' })

test('a missing composer reloads the original conversation before filling again', async () => {
  const { session, driver, submitted, previous, filled, opened, logs } = fixture()
  const fill = driver.fillLong.bind(driver)
  let fail = true
  driver.fillLong = async (...args) => {
    if (fail) { fail = false; throw timeout('locator.fill: Timeout 30000ms exceeded') }
    return fill(...args)
  }
  assert.equal((await session.ask('RECOVER_COMPOSER')).reply, 'RECOVER_COMPOSER')
  assert.deepEqual(opened, [previous])
  assert.deepEqual(filled, ['', 'RECOVER_COMPOSER'])
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].url, previous)
  assert.ok(logs.some(message => message.includes('2/3')))
})

test('a disabled send button clears and refills the draft without duplicating its attachments', async () => {
  const { session, driver, submitted, filled, opened } = fixture({ withPlugin: true })
  const click = driver.click.bind(driver)
  const attachments = [{ name: 'image.png', path: '/unit/image.png' }]
  let clicks = 0
  let uploads = 0
  let releases = 0
  driver.attachFiles = async files => { uploads++; assert.deepEqual(files, attachments); return { release: async () => { releases++ } } }
  session.waitUploads = async () => {}
  driver.click = async (selector, options) => {
    if (selector === SITE_PRESETS.chatgpt.adapter.sendSelector && ++clicks === 1) throw timeout('locator.click: element is not enabled')
    return click(selector, options)
  }
  const result = await session.ask('RECOVER_SEND', { attachments })
  assert.equal(result.reply, 'RECOVER_SEND')
  assert.deepEqual(filled, ['RECOVER_SEND', '', 'RECOVER_SEND'])
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].plugin, true)
  assert.deepEqual(opened, [])
  assert.equal(uploads, 1)
  assert.equal(releases, 1)
})

test('a click that leaves the draft in place is retried instead of ending the DSH turn', async () => {
  const { session, driver, submitted, filled } = fixture()
  const click = driver.click.bind(driver)
  let clicks = 0
  driver.click = async (selector, options) => {
    if (selector === SITE_PRESETS.chatgpt.adapter.sendSelector && ++clicks === 1) return
    return click(selector, options)
  }
  await session.ask('RECOVER_UNSENT')
  assert.deepEqual(filled, ['RECOVER_UNSENT', '', 'RECOVER_UNSENT'])
  assert.equal(submitted.length, 1)
})

test('a send timeout after actual delivery accepts the new user turn without resending', async () => {
  const { session, driver, submitted, filled, opened } = fixture()
  const click = driver.click.bind(driver)
  driver.click = async (...args) => { await click(...args); throw timeout('locator.click: navigation interrupted') }
  assert.equal((await session.ask('ALREADY_SENT')).reply, 'ALREADY_SENT')
  assert.equal(submitted.length, 1)
  assert.deepEqual(filled, ['ALREADY_SENT'])
  assert.deepEqual(opened, [])
})

test('a delivered user turn remains authoritative while the composer still shows stale text', async () => {
  const { session, driver, submitted } = fixture()
  const evaluate = driver.eval.bind(driver)
  driver.eval = async expression => expression.includes('composerText')
    ? { result: { composerCount: 1, composerText: 'DELIVERED_DRAFT' } } : evaluate(expression)
  assert.equal((await session.ask('DELIVERED_DRAFT')).reply, 'DELIVERED_DRAFT')
  assert.equal(submitted.length, 1)
})

test('a missing composer is not mistaken for an empty draft or permission to resend', async () => {
  const { session, driver, clicked, filled } = fixture({ rejectSubmission: true })
  const evaluate = driver.eval.bind(driver)
  driver.eval = async expression => expression.includes('composerText')
    ? { result: { composerCount: 0, composerText: '' } } : evaluate(expression)
  await assert.rejects(session.ask('UNKNOWN_DELIVERY'), error => error.code === 'message-send-uncertain')
  assert.equal(clicked.filter(selector => selector === SITE_PRESETS.chatgpt.adapter.sendSelector).length, 1)
  assert.deepEqual(filled, ['UNKNOWN_DELIVERY'])
})

test('a second failed send reloads the same conversation and reapplies the selected web model', async () => {
  const { session, driver, submitted, previous, opened } = fixture()
  const click = driver.click.bind(driver)
  let clicks = 0
  let selected = 0
  session.modelControl = { async select(model) { assert.equal(model.modelName, 'unit-model'); selected++ } }
  driver.click = async (selector, options) => {
    if (selector === SITE_PRESETS.chatgpt.adapter.sendSelector && ++clicks < 3) throw timeout('locator.click: element is not enabled')
    return click(selector, options)
  }
  await session.ask('RECOVER_AFTER_RELOAD', { webModel: { modelName: 'unit-model' } })
  assert.equal(submitted.length, 1)
  assert.deepEqual(opened, [previous])
  assert.equal(selected, 3)
})

test('reloading an unsent conversation uploads its files again and releases both upload leases', async () => {
  const { session, driver, submitted, previous, opened } = fixture({ withPlugin: true })
  const click = driver.click.bind(driver)
  let clicks = 0
  let uploads = 0
  let releases = 0
  const attachment = { name: 'context.txt', content: 'context' }
  driver.attachFiles = async files => {
    uploads++
    assert.deepEqual(files, [attachment])
    return { release: async () => { releases++ } }
  }
  session.waitUploads = async () => {}
  driver.click = async (selector, options) => {
    if (selector === SITE_PRESETS.chatgpt.adapter.sendSelector && ++clicks < 3) return
    return click(selector, options)
  }
  const result = await session.ask('KEEP_ATTACHMENTS', { attachment })
  assert.equal(result.contextAttachmentDelivered, true)
  assert.equal(result.contextAttachmentSkipped, false)
  assert.deepEqual(opened, [previous])
  assert.equal(uploads, 2)
  assert.equal(releases, 2)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].plugin, true)
})

test('reloading does not upload a system attachment already skipped for quota', async () => {
  const { session, driver, submitted } = fixture({ withPlugin: true })
  const click = driver.click.bind(driver)
  let clicks = 0
  let uploads = 0
  session.uploadState = async () => ({ problem: { code: 'attachment-quota-exceeded', message: 'quota' } })
  session.dismissUploadNotice = async () => {}
  driver.attachFiles = async () => { uploads++; throw new Error('quota-skipped files must not be uploaded') }
  driver.click = async (selector, options) => {
    if (selector === SITE_PRESETS.chatgpt.adapter.sendSelector && ++clicks < 3) return
    return click(selector, options)
  }
  const result = await session.ask('KEEP_QUOTA_FALLBACK', { attachment: { name: 'context.txt', content: 'context' } })
  assert.equal(result.contextAttachmentDelivered, false)
  assert.equal(result.contextAttachmentSkipped, true)
  assert.equal(uploads, 0)
  assert.equal(submitted.length, 1)
})

test('persistent composer timeouts stop after three attempts and do not expose prompt text in logs', async () => {
  const { session, driver, submitted, logs, opened } = fixture()
  let fills = 0
  driver.fillLong = async () => { fills++; throw timeout('locator.fill: timeout with PRIVATE_PROMPT') }
  await assert.rejects(session.ask('PRIVATE_PROMPT'), error => error.code === 'composer-not-ready' && error.details.attempts === 3)
  assert.equal(fills, 3)
  assert.equal(opened.length, 2)
  assert.equal(submitted.length, 0)
  assert.ok(logs.every(message => !message.includes('PRIVATE_PROMPT')))
})

test('clearing a draft without creating a user turn does not count as successful delivery', async () => {
  const { session, driver, clicked, submitted } = fixture()
  const fill = driver.fillLong.bind(driver)
  driver.click = async () => { await fill('', '') }
  await assert.rejects(session.ask('LOST_DRAFT'), error => error.code === 'message-send-uncertain')
  assert.equal(clicked.length, 0)
  assert.equal(submitted.length, 0)
})

test('a user edit after clicking send is preserved instead of being overwritten by recovery', async () => {
  const { session, driver, submitted, filled } = fixture()
  const released = []
  driver.releasePage = async key => { released.push(key) }
  const evaluate = driver.eval.bind(driver)
  driver.click = async () => {}
  driver.eval = async expression => expression.includes('composerText')
    ? { result: { composerCount: 1, composerText: 'NEW_USER_DRAFT' } } : evaluate(expression)
  await assert.rejects(session.ask('ORIGINAL_DRAFT', { sessionKey: 'keep-draft' }), error => error.code === 'message-send-uncertain')
  assert.equal(submitted.length, 0)
  assert.deepEqual(filled, ['ORIGINAL_DRAFT'])
  assert.deepEqual(released, [])
})

test('an empty composer with the message visible in a new user turn is accepted even when the scraped user text differs', async () => {
  // Reproduces message-send-uncertain: the ChatGPT turn node exists (brand-new
  // userTurnKey) but its scraped userText is a sanitized/divergent form (e.g.
  // image placeholder), while the composer has already leaked the whole draft
  // back as visible text. The send landed and must not be reported uncertain.
  const { session, driver } = fixture()
  driver.eval = async expression => {
    if (expression.includes('composerText')) return { result: { composerCount: 1, composerText: 'SHORT_PROMPT' } }
    return { result: { count: 5, text: 'partial reply', streaming: false,
      url: 'https://chatgpt.com/c/previous', userTurnKey: 'fresh-turn-key',
      userText: 'different rendered prompt [image]', replyTurnKey: 'fresh-turn-key', replyId: 'fresh-turn-key' } }
  }
  const baseline = { userTurnKey: 'previous-turn-key', count: 4, text: 'old reply', url: 'https://chatgpt.com/c/previous' }
  const state = await session.readSubmission('SHORT_PROMPT', session.adapter(), baseline)
  assert.ok(state.sent, 'expected sent, got ' + JSON.stringify(state))
})

test('transient page reads after sending recover the receipt without another click', async () => {
  const { session, driver, submitted, filled } = fixture()
  session.settings.commandTimeoutMs = 300
  const evaluate = driver.eval.bind(driver)
  let reads = 0
  driver.eval = async expression => {
    if (submitted.length && reads++ < 2) throw new Error('Execution context was destroyed, most likely because of a navigation')
    return evaluate(expression)
  }
  assert.equal((await session.ask('READ_RECEIPT_AGAIN')).reply, 'READ_RECEIPT_AGAIN')
  assert.equal(submitted.length, 1)
  assert.deepEqual(filled, ['READ_RECEIPT_AGAIN'])
})

test('a delayed send received just before retrying prevents a second fill or click', async () => {
  const { session, driver, submitted, filled } = fixture()
  const evaluate = driver.eval.bind(driver)
  const click = driver.click.bind(driver)
  let clicked = false
  let reads = 0
  driver.click = async () => { clicked = true }
  driver.eval = async expression => {
    if (clicked && !expression.includes('composerText') && ++reads === 2) await click(SITE_PRESETS.chatgpt.adapter.sendSelector)
    return evaluate(expression)
  }
  assert.equal((await session.ask('LATE_DELIVERY')).reply, 'LATE_DELIVERY')
  assert.equal(submitted.length, 1)
  assert.deepEqual(filled, ['LATE_DELIVERY'])
})

test('send recovery on a fresh chat notifies context preparation when reopening restores an old chat', async () => {
  const { session, driver, submitted, previous } = fixture()
  const fill = driver.fillLong.bind(driver)
  let fail = true
  driver.fillLong = async (...args) => {
    if (fail) { fail = false; throw timeout('composer is missing') }
    return fill(...args)
  }
  const observations = []
  let prepared = 0
  await session.ask('FRESH_TASK', {
    sessionKey: 'recover-fresh',
    onConversation: info => observations.push({ ...info }),
    prepareMessage: () => ({ text: `FULL_CONTEXT_${++prepared}` }),
  })
  assert.equal(submitted.length, 1)
  assert.notEqual(submitted[0].url, previous)
  assert.equal(submitted[0].text, 'FULL_CONTEXT_2')
  assert.equal(observations[1].reason, 'send-recovery')
  assert.notEqual(observations[0].generation, observations[1].generation)
})

test('cancelling recovery stops before another fill or click', async () => {
  const { session, driver, submitted, filled } = fixture()
  const controller = new AbortController()
  driver.fillLong = async () => { controller.abort(); throw timeout('composer is missing') }
  await assert.rejects(session.ask('CANCEL_RECOVERY', { signal: controller.signal }), error => error.code === 'aborted')
  assert.deepEqual(filled, [])
  assert.equal(submitted.length, 0)
})

test('cancelling while delivery is being checked interrupts the polling delay', async () => {
  const { session, filled } = fixture({ rejectSubmission: true })
  session.settings.commandTimeoutMs = 60000
  const controller = new AbortController()
  const pending = session.ask('CANCEL_CONFIRMATION', { signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, error => error.code === 'aborted')
  assert.deepEqual(filled, ['CANCEL_CONFIRMATION'])
})

test('a restored conversation checks its login state before filling or sending', async () => {
  const { session, driver, filled } = fixture()
  session.conversations.set('chatgpt:expired', { url: 'https://chatgpt.com/c/previous' })
  driver.state = async () => ({ url: 'https://chatgpt.com/c/previous', manualAuth: { required: true, kind: 'login' } })
  await assert.rejects(session.ask('EXPIRED_LOGIN', { sessionKey: 'expired' }), error => error.code === 'auth-required:login')
  assert.deepEqual(filled, [])
})

test('transient connection errors while restoring a conversation retry its saved address', async () => {
  const { session, driver, submitted, previous, opened } = fixture({ initialUrl: 'https://example.com/' })
  session.conversations.set('chatgpt:restore', { url: previous })
  const open = driver.open.bind(driver)
  let attempts = 0
  driver.open = async (...args) => { attempts++; if (attempts === 1) throw new Error('page.goto: net::ERR_CONNECTION_RESET'); return open(...args) }
  await session.ask('RECOVER_CONNECTION', { sessionKey: 'restore' })
  assert.equal(attempts, 2)
  assert.deepEqual(opened, [previous])
  assert.equal(submitted[0].url, previous)
})

test('a failed first state read reconnects an existing session before sending', async () => {
  const { session, driver, submitted, previous } = fixture()
  session.conversations.set('chatgpt:reconnect', { url: previous })
  const state = driver.state.bind(driver)
  let reads = 0
  driver.state = async () => { if (++reads === 1) throw new Error('Target page, context or browser has been closed'); return state() }
  await session.ask('RECONNECT_PAGE', { sessionKey: 'reconnect' })
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].url, previous)
})

test('a missing saved conversation cannot redirect a task into another conversation', async () => {
  const { session, driver, submitted, filled } = fixture({ initialUrl: 'https://example.com/' })
  session.conversations.set('chatgpt:missing', { url: 'https://chatgpt.com/c/missing' })
  const open = driver.open.bind(driver)
  let attempts = 0
  driver.open = async () => { attempts++; return open('https://chatgpt.com/') }
  await assert.rejects(session.ask('WRONG_CONVERSATION', { sessionKey: 'missing' }), error => error.code === 'page-not-ready' && error.details.attempts === 3)
  assert.equal(attempts, 3)
  assert.deepEqual(filled, [])
  assert.equal(submitted.length, 0)
})

test('the first web message includes its attachment, user text, and WebBridge DSH mention', async () => {
  const { session, submitted, clicked } = fixture({ withPlugin: true })
  const attachment = { name: 'dsh-context.txt', content: 'SYSTEM_CONTEXT' }
  await session.ask('FIRST_USER_TEXT', { sessionKey: 'plugin-chat', attachment })
  await session.ask('SECOND_USER_TEXT', { sessionKey: 'plugin-chat' })
  assert.equal(submitted[0].text, 'FIRST_USER_TEXT')
  assert.equal(submitted[0].plugin, true)
  assert.deepEqual(submitted[0].attachment, attachment)
  assert.equal(submitted[1].text, 'SECOND_USER_TEXT')
  assert.equal(submitted[1].attachment, null)
  assert.equal(submitted[1].url, submitted[0].url)
  assert.equal(clicked.filter((selector) => selector.includes('data-plugin-impression-id')).length, 1)
})

test('exhausted attachment quota skips only the system TXT and still sends user text with the app', async () => {
  const { session, submitted } = fixture({ withPlugin: true })
  const calls = []
  session.uploadState = async () => ({ problem: { code: 'attachment-quota-exceeded', message: '你已达到文件附件数量限制' } })
  session.dismissUploadNotice = async () => { calls.push('cancel') }
  const reply = await session.ask('USER_TEXT_WITHOUT_SYSTEM_FILE', { sessionKey: 'quota-fallback', attachment: { name: 'dsh-context.txt', content: 'SYSTEM_CONTEXT' } })
  assert.equal(calls[0], 'cancel')
  assert.equal(submitted[0].text, 'USER_TEXT_WITHOUT_SYSTEM_FILE')
  assert.equal(submitted[0].attachment, null)
  assert.equal(submitted[0].plugin, true)
  assert.equal(reply.reply, 'USER_TEXT_WITHOUT_SYSTEM_FILE')
})

test('a user image or file blocked by quota preserves the exact OpenAI notice and is not silently omitted', async () => {
  const { session, submitted } = fixture({ withPlugin: true })
  const notice = '你已达到文件附件数量限制\n升级订阅即可立即添加更多文件，或在 11月18日 0:53 后重试'
  session.uploadState = async () => ({ problem: { code: 'attachment-quota-exceeded', message: notice } })
  await assert.rejects(session.ask('READ_MY_IMAGE', { sessionKey: 'quota-image', attachment: { name: 'dsh-context.txt', content: 'context' }, attachments: [{ name: 'image.png', path: 'C:/image.png' }] }), error => error.code === 'attachment-quota-exceeded' && error.message === notice)
  assert.equal(submitted.length, 0)
})
