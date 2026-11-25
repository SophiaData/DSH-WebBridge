/**
 * ChatGPT web model provider for DSH.
 *
 * The provider forwards the prompt to ChatGPT. Native MCP calls execute DSH
 * tools synchronously through the local bridge and remain visible in DSH.
 *
 * Chunk vocabulary (measured from @deepseek-ai/dsh-llm BlockAssembler):
 *   {type:'block-start', index, blockType:'text'|'reasoning'|'tool-call'}
 *   {type:'text-delta', index, text}
 *   {type:'tool-call-delta', index, id, name?, argumentsDelta}
 *   {type:'block-end', index, block}
 *   {type:'usage', usage}
 *   {type:'finish', reason:{kind}}
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BridgeError, digest } from './envelope.js'
import { snapshotDelta, streamPreview } from './stream-text.js'
import { CONTEXT_TOOL_NAME } from './context.js'
import { contextHash, contextHashes } from './context-identity.js'
import { createActivity } from './activity.js'

// Composer text and model context have separate transports. Only genuine user
// input belongs in the composer; every injected message remains in the snapshot.
function directUserMessage(message) {
  return message?.role === 'user' && (!message.source?.kind || message.source.kind === 'user')
}

function rawMessageText(message) {
  if (typeof message?.content === 'string') return message.content
  return (Array.isArray(message?.content) ? message.content : [])
    .map(block => typeof block === 'string' ? block : block?.type === 'text' ? String(block.text || '') : '')
    .filter(Boolean).join('\n')
}

function contextNotice(reference, since) {
  const args = { context_id: reference.context_id, ...(since ? { since_context_id: since } : {}) }
  return `调用 WebBridge DSH 的 ${CONTEXT_TOOL_NAME}，参数为 ${JSON.stringify(args)}。` +
    '读取所有分页，直到 completeness.complete=true，再处理输入框中的任务。项目地址、有效指令和上下文注入都在工具结果中。后续调用 DSH 工具时，如果工具参数里有 dsh_context_id，始终填当前 context_id；这是 MCP 路由字段，DSH 工具本身不会收到它。' +
    (since ? '仅在仍保留此前完整上下文时使用 since_context_id，否则省略它重新读取全量。' : '')
}

/**
 * Tool schemas affect what the web model may call; per-call results and random
 * call IDs do not. Hash only the stable catalog/instruction part.
 */
function meaningfulToolContext(toolHistory) {
  if (!Array.isArray(toolHistory?.tools)) return null
  const tools = new Map(toolHistory.tools.map(tool => [tool.name, tool]))
  for (const update of toolHistory.updates || []) {
    for (const tool of update.additions || []) tools.set(tool.name, tool)
  }
  return { tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

/** Flatten DSH messages into one prompt the web chat can accept. */
export function flattenMessages(messages) {
  const parts = []
  for (const message of messages || []) {
    const role = message?.role || 'user'
    const content = message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          if (typeof block === 'string') return block
          if (!block || typeof block !== 'object') return ''
          if (block.type === 'text') return block.text || ''
          if (block.type === 'tool-result') return `[tool ${block.name || ''}] ${typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? '')}`
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    if (!text) continue
    text = stripReminders(text)
    if (!text) continue
    parts.push(role === 'assistant' ? `助手：${text}` : role === 'system' ? `[系统]\n${text}` : `用户：${text}`)
  }
  return parts.join('\n\n')
}

/** Tool definitions the web model may call, rendered compactly (A+ protocol). */
export function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const compact = tools.map((tool) => ({
    name: tool.name,
    description: String(tool.description || '').split('\n')[0].slice(0, 140),
    parameters: tool.parameters || tool.inputSchema || {},
  }))
  return [
    '【工具调用规则】下面是你此刻唯一可以使用的工具清单：',
    '<<<NEXUS_TOOLS>>>',
    JSON.stringify(compact),
    '<<<END_NEXUS_TOOLS>>>',
    '',
    '要调用工具时，你必须只输出下面这种格式，不要加任何解释、不要用 XML、不要用函数语法：',
    '<<<TOOL_CALLS>>>',
    '[{"name":"<工具名>","arguments":{"<参数名>":"<参数值>"}}]',
    '<<<END_TOOL_CALLS>>>',
    '',
    '给出最终答复时，把答复包在 <<<FINAL>>> 与 <<<END_FINAL>>> 之间。',
    '如果你不调用工具也能回答，就直接用 <<<FINAL>>> 包裹答复。',
  ].join('\n')
}

/** Legacy composer filters only; native MCP snapshots bypass these filters. */
const HARNESS_NOISE = [
  'Time sampled while preparing',
  'Browser time zone for this request',
  'Elapsed since the preceding',
  'Current DeepSeek Harness implementation checkout',
  '收到时间记录',
]

/**
 * DSH appends `<system-reminder>` blocks (skill catalogue, environment notes)
 * *inside* the user message. They are harness bookkeeping, not user speech, and
 * they were landing verbatim in the web composer.
 */
export function stripReminders(text) {
  let out = String(text || '')
  // Remove every system-reminder block, including the nested available_skills list.
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
  // Stray fragments when a block is split across messages.
  out = out.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, ' ')
  out = out.replace(/<\/?system-reminder>/gi, ' ')
  return out.trim()
}

/** Flatten a message's content into plain text, whatever shape it arrived in. */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return stripReminders(content)
  if (Array.isArray(content)) {
    return stripReminders(
      content
        .map((block) => (typeof block === 'string' ? block : block && block.type === 'text' ? String(block.text || '') : ''))
        .join('\n'),
    )
  }
  return ''
}

/**
 * Harness metadata is usually a whole message, but it also arrives wrapped in
 * arrays or prefixed with other text, so match anywhere in the flattened text
 * instead of only at the start.
 */
export function isHarnessNoise(message) {
  const text = messageText(message).trim()
  if (!text) return false
  if (HARNESS_NOISE.some((needle) => text.includes(needle))) return true
  // A message that is nothing but a timestamp/zone note carries no user intent.
  const stripped = text.replace(/[\s\S]*?(用户|User)\s*[:：]/, '')
  return /^\s*(Time sampled|Browser time zone|Elapsed since)/i.test(stripped)
}

/** Derive a short session title locally instead of asking the web model. */
export function deriveTitle(messages) {
  const texts = []
  for (const message of messages || []) {
    if (!message || message.role !== 'user') continue
    const text = messageText(message)
    if (!text) continue
    // The title producer embeds its input as a JSON array of human messages.
    const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
    if (match) {
      try {
        const parsed = JSON.parse(match[0])
        for (const item of parsed) if (item && typeof item.text === 'string') texts.push(stripReminders(item.text))
        continue
      } catch {}
    }
    texts.push(text)
  }
  const first = (texts.find((entry) => entry && !isHarnessNoise({ content: entry })) || '')
    .replace(/(^|\s)@(?:[A-Za-z]:[\\/]|\/)\S+\s*/g, '$1').trim()
  if (!first) return '新会话'
  return first.replace(/\s+/g, ' ').slice(0, 18)
}

export class WebChatAdapter {
  constructor({ providerId, displayName, modelId, session, settings, log, parseReply, toolScope, contextStore, contextAvailable, accountTier, modelCatalog, siteAuth, dualReasoning }) {
    this.providerId = providerId
    this.displayName = displayName
    this.modelId = modelId
    this.session = session
    this.settings = settings
    this.log = log || (() => {})
    this.parseReply = parseReply
    this.toolScope = toolScope
    this.contextStore = contextStore
    this.contextAvailable = contextAvailable
    this.accountTier = accountTier
    this.modelCatalog = modelCatalog
    // Login gate for non-ChatGPT sites: their models appear only after the
    // person signs in through the settings page. ChatGPT keeps its own
    // observeAccount flow and stays listed for continuity.
    this.siteAuth = siteAuth || null
    // Sites with a binary thinking toggle (DeepSeek DeepThink) expose
    // 思考/非思考 as two DSH models, mirroring ChatGPT's free-tier pair.
    this.dualReasoning = dualReasoning === true
    /**
     * Per DSH-session bookkeeping. One DSH session already maps to one web
     * conversation, so initial history is sent once and tool definitions are
     * refreshed only when they change. Later turns send just the new messages.
     * Resending everything made each message enormous and is what tripped the
     * site's abuse checks.
     */
    this.sessionState = new Map()
  }

  #state(sessionId) {
    const key = sessionId || 'default'
    let state = this.sessionState.get(key)
    if (!state) {
      state = { bootstrapped: false, contextDelivered: false, sentMessages: 0, sentUserKeys: [], toolContext: '', contextReference: null, contextDigest: null }
      this.sessionState.set(key, state)
    }
    return state
  }

  /** Read the existing mapped web conversation without resetting its cursor. */
  async syncSession(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) throw new BridgeError('session-required', '同步网页会话需要当前 DSH sessionId。')
    return this.session.readConversation({ site: this.settings.site, sessionKey: id })
  }

  /** Imported user turns were already delivered on the same web conversation. */
  noteSynchronized(sessionId, messages) {
    const state = this.sessionState.get(String(sessionId))
    if (!state?.bootstrapped) return
    const users = messages.filter(message => directUserMessage(message))
    state.sentMessages = users.length
    state.sentUserKeys = users.map(message => `${message.id || ''}:${digest(message.content)}`)
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  /** The registry validates these even when a route declares no policy. */
  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image?.width, height: image?.height, maxBytes: image?.bytes }
  }

  async listModels(provider) {
    // Sites the person has not signed in to stay out of the DSH model menu.
    if (this.settings.site !== 'chatgpt' && this.siteAuth && this.siteAuth() !== 'ready') {
      this.paidCatalog = []
      return []
    }
    // The registry validates every entry: provider/id/name must be non-empty
    // strings and `provider` must equal the route, or the catalog is rejected
    // with INVALID_CATALOG ("invalid or duplicate model metadata").
    const tier = this.accountTier ? await this.accountTier() : 'unknown'
    // ChatGPT free accounts and dual-reasoning sites (DeepSeek) expose
    // 思考/非思考 as two models; the chosen one drives the page toggle.
    if ((this.settings.site === 'chatgpt' && tier === 'free') || this.dualReasoning) {
      this.paidCatalog = []
      return [
        { provider, id: this.modelId, name: `${this.displayName}（思考）`, contextWindow: this.settings.providers?.contextWindow || 32000, supportsTools: true, inputModalities: ['text', 'image'] },
        { provider, id: `${this.modelId}-instant`, name: `${this.displayName}（非思考）`, contextWindow: this.settings.providers?.contextWindow || 32000, supportsTools: true, inputModalities: ['text', 'image'] },
      ]
    }
    const choices = this.modelCatalog ? await this.modelCatalog() : []
    this.paidCatalog = choices
    if (choices.length) return [...new Set(choices.map(choice => choice.modelName))].map(name => {
      const first = choices.find(choice => choice.modelName === name)
      const idKey = this.settings.site === 'gemini' && first?.key ? first.key : paidKey(name)
      return this.modelInfo(provider, `${this.modelId}-${idKey}`, { modelName: name, choices: choices.filter(choice => choice.modelName === name) })
    })
    return [
      {
        provider,
        id: this.modelId,
        name: this.displayName,
        description: `${this.displayName}（浏览器驱动，无需 API Key）`,
        contextWindow: this.settings.providers?.contextWindow || 32000,
        supportsTools: true,
        inputModalities: ['text', 'image'],
      },
    ]
  }

  async resolveModel(provider, model, signal) {
    return this.modelInfo(provider, model, await this.selectionFor(model, signal))
  }

  async selectionFor(model, signal) {
    signal?.throwIfAborted()
    const prefix = this.settings.site === 'gemini' ? `${this.modelId}-mode-` : `${this.modelId}-paid-`
    if (!String(model || '').startsWith(prefix)) return null
    const catalog = this.modelCatalog ? this.modelCatalog() : Promise.resolve([])
    let aborted
    const choices = signal ? await Promise.race([catalog, new Promise((_, reject) => {
      aborted = () => reject(signal.reason || new Error('请求已中止。'))
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })]).finally(() => signal.removeEventListener('abort', aborted)) : await catalog
    const match = choices.find(choice => `${this.modelId}-${paidKey(choice.modelName)}` === model || `${this.modelId}-${choice.key}` === model)
    if (!match) throw new BridgeError('model-unavailable', '所选网页模型或思考档位已不可用，请刷新模型列表。')
    return { modelName: match.modelName, choices: choices.filter(choice => choice.modelName === match.modelName).map(choice => ({ ...choice })), legacyPower: `${this.modelId}-${match.key}` === model ? match.power : undefined }
  }

  modelInfo(provider, model, choice) {
    return {
      provider,
      id: model,
      name: choice ? choice.modelName : (this.settings.site === 'chatgpt' || this.dualReasoning) ? `${this.displayName}（${model === `${this.modelId}-instant` ? '非思考' : this.paidCatalog?.length ? '网页当前设置' : '思考'}）` : this.displayName,
      ...(choice ? { reasoning: { efforts: choice.choices.map(level => ({ id: `web-${level.power}`, name: level.label })), defaultEffort: `web-${(choice.choices.find(level => level.power === choice.legacyPower) || choice.choices.find(level => level.preferred) || choice.choices[0]).power}` } } : {}),
      ...(this.settings.site === 'gemini' && choice ? { description: `${this.displayName} · ${choice.modelName}` } : {}),
      contextWindow: this.settings.providers?.contextWindow || 32000,
      supportsTools: true,
      inputModalities: ['text', 'image'],
    }
  }

  async prepareCall(provider, model, signal) {
    const selection = await this.selectionFor(model, signal)
    return {
      model: this.modelInfo(provider, model, selection),
      stream: (options) => this.generate({ ...options, model }, selection),
    }
  }

  stream(options) {
    return this.generate(options)
  }

  /** One provider attempt: one browser round trip, emitted as DSH chunks. */
  async *generate(options, preparedSelection) {
    const activity = createActivity(this.settings, this.log, { sessionId: options.sessionId, site: this.settings.site })
    const messages = Array.isArray(options.messages) ? options.messages : []
    activity.emit('input.received', '收到 DSH 输入，开始处理本轮请求', {
      messageCount: messages.length, toolCount: options.tools?.length || 0, purpose: options.purpose || 'chat',
      inputChars: messages.reduce((total, message) => total + rawMessageText(message).length, 0),
    })
    let outputChars = 0
    let outputStarted = false
    let finished = false
    try {
      for await (const chunk of this.generateResponse({ ...options, activity }, preparedSelection)) {
        if (chunk.type === 'text-delta') {
          outputChars += chunk.text.length
          if (!outputStarted) { outputStarted = true; activity.emit('output.started', '开始向 DSH 回传回复正文') }
        }
        if (chunk.type === 'finish') {
          finished = true
          activity.emit('output.finished', '本轮 DSH 输出结束', { outputChars, reason: chunk.reason?.kind })
        }
        yield chunk
      }
    } catch (error) {
      finished = true
      activity.emit('request.failed', '本轮请求失败', { code: error.cause?.code || error.code || error.name })
      throw error
    } finally {
      if (!finished) activity.emit('request.cancelled', 'DSH 已停止读取本轮输出')
    }
  }

  async *generateResponse(options, preparedSelection) {
    const activity = options.activity
    const purpose = typeof options.purpose === 'string' ? options.purpose : ''
    const isMainChat = !purpose || purpose === 'chat'
    const messages = Array.isArray(options.messages) ? options.messages : []
    let allMessages = messages.filter((message) => message && !isHarnessNoise(message))
    const firstUser = allMessages.find((message) => message.role === 'user' && messageText(message))
    // Omitted session IDs use the first real user message, excluding timestamps
    // and reminders. Hash the full text so a shared prefix cannot merge chats.
    const baseSessionId = options.sessionId == null ? `anon-${digest(messageText(firstUser))}` : String(options.sessionId)
    // Restore real user blocks captured before DSH converts files into tool
    // path handles. The web upload carries these bytes directly.
    if (isMainChat && this.toolScope?.originalMessage) allMessages = allMessages.map(message => this.toolScope.originalMessage(baseSessionId, message))
    // Auxiliary producers (session-title, compaction) must not touch the user's
    // web conversation: give them their own conversation key, and never inject
    // tools or the context notice there.
    const sessionId = isMainChat ? baseSessionId : `${baseSessionId}#${purpose}`
    const state = this.#state(sessionId)

    // One-shot payload dump: the web UI showed a long system prompt reaching the
    // composer, so record exactly what the harness hands us (roles + prefixes).
    try {
      const dump = {
        at: new Date().toISOString(),
        purpose,
        sessionId: sessionId ?? null,
        messages: messages.map((m) => ({
          role: m?.role,
          type: typeof m?.content,
          len: messageText(m).length,
          // Do not persist user prompt prefixes or credentials in debug files.
          contentType: Array.isArray(m?.content) ? 'blocks' : typeof m?.content,
        })),
        tools: (options.tools || []).length,
      }
      writeFileSync(join(this.settings.stateDir, 'provider-debug.json'), JSON.stringify(dump, null, 2), 'utf8')
    } catch {}

    // Session titles are computed locally: asking the web model created an
    // extra visible conversation for every DSH session and cluttered the account.
    if (purpose.includes('title')) {
      const title = deriveTitle(messages)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const selected = preparedSelection === undefined ? await this.selectionFor(options.model, options.signal) : preparedSelection
    const webModel = selected && (options.reasoningEffort ? selected.choices.find(level => `web-${level.power}` === options.reasoningEffort) : selected.choices.find(level => level.power === selected.legacyPower) || selected.choices.find(level => level.preferred) || selected.choices[0])
    if (selected && !webModel) throw new BridgeError('reasoning-unavailable', '请选择推理等级，当前网页不支持所选档位。')
    // Native ChatGPT reads the effective DSH input through MCP. The composer
    // carries only the bootstrap reference and new user input. Other routes
    // retain their existing text-attachment transport.
    // DSH appends runtime-context and skill-catalog messages after the user's
    // input. They can become empty after stripReminders; exclude them before
    // choosing the final message or advancing the incremental history cursor.
    // Flattening also preserves tool results whose messageText() is empty.
    const nativeMcp = this.settings.site === 'chatgpt' && typeof this.parseReply !== 'function'
    const nativeContext = isMainChat && nativeMcp && Boolean(this.contextStore)
    if (nativeContext && this.contextAvailable && !this.contextAvailable()) {
      throw new BridgeError('context-tool-unavailable', '桥接插件尚未暴露 dsh_get_context。请在现有 MCP 工具范围中启用该工具并刷新连接，再重试。')
    }
    const geminiText = isMainChat && this.settings.site === 'gemini'
    const snapshotMessages = nativeContext ? messages : null
    const userMessages = nativeContext
      ? snapshotMessages.filter(directUserMessage).map(message => this.toolScope?.originalMessage?.(baseSessionId, message) || message)
      : allMessages.filter((message) => message.role !== 'system' && message.role !== 'assistant' &&
      !(nativeMcp && String(message.source?.callId || '').startsWith('wb_mcp_')) &&
      (flattenMessages([message]) || this.toolScope?.hasAttachments?.(baseSessionId, message)))
    const userKeys = nativeContext || geminiText ? userMessages.map(message => `${message.id || ''}:${digest(message.content)}`) : []
    let delta = state.bootstrapped ? userMessages.slice(state.sentMessages) : userMessages.slice(-1)
    if ((nativeContext || geminiText) && state.bootstrapped) {
      let common = 0
      while (common < userKeys.length && common < state.sentUserKeys.length && userKeys[common] === state.sentUserKeys[common]) common++
      delta = common === state.sentUserKeys.length ? userMessages.slice(common)
        : userKeys.length && userKeys.at(-1) !== state.sentUserKeys.at(-1) ? userMessages.slice(-1) : []
    }
    // A submitted Gemini turn is already visible in the remote conversation.
    // Do not resubmit it if DSH retries after waiting for the reply failed.
    if (geminiText && state.bootstrapped && delta.length === 0) {
      throw new BridgeError('gemini-turn-already-submitted',
        '本轮 Gemini 消息已经发出，不能自动重发以免重复调用工具。请检查原网页会话，或发送新的明确指令。')
    }
    // Auxiliary tasks need their system instructions and complete input on
    // every request; they do not receive the main chat's context notice.
    let prompt = nativeContext ? delta.map(message => rawMessageText(message)).filter(Boolean).join('\n\n')
      : flattenMessages(isMainChat ? (delta.length > 0 ? delta : userMessages.slice(-1)) : allMessages)
    const attachmentMessages = nativeContext ? delta : delta.length > 0 ? delta : userMessages.slice(-1)
    const attachments = isMainChat ? await this.toolScope?.attachmentsFor?.(baseSessionId, attachmentMessages) || [] : []
    for (const file of attachments) if (file.mention) prompt = prompt.split(file.mention).join(`[附件：${file.name}]`)
    if (!prompt.trim() && attachments.length) prompt = '用户上传了附件，请结合附件回复。'
    if (!prompt.trim() && !nativeContext) {
      throw new BridgeError('empty-message', `[${this.providerId}] No message text remains after removing DSH context reminders.`)
    }
    const maxChars = Number(this.settings.providers?.maxPromptChars) || (geminiText ? 32000 : 12000)
    if (prompt.length > maxChars) {
      if (geminiText) throw new BridgeError('gemini-prompt-too-large', `Gemini 网页输入超过 ${maxChars} 字符；为避免截断工具参数，请缩小本轮输入。`)
      const head = prompt.slice(0, Math.floor(maxChars * 0.3))
      const tail = prompt.slice(-Math.floor(maxChars * 0.65))
      prompt = `${head}\n\n[…较早的对话已省略…]\n\n${tail}`
    }

    const tools = (Array.isArray(options.tools) ? options.tools : []).slice(0, Number(this.settings.providers?.maxPromptTools) || 16)
    const withTools = isMainChat && tools.length > 0 && typeof this.parseReply === 'function'
    const toolContext = withTools ? renderTools(tools) : ''
    const updateTools = withTools && toolContext !== state.toolContext

    // Preserve the complete request for full recovery, but advance context_id
    // only when injected instructions, environment or tool availability changed.
    // Ordinary user/assistant/tool history already lives in the web conversation.
    const contextToolHistory = nativeContext
      ? options.toolHistory ?? this.toolScope?.originalRequest?.(baseSessionId)?.toolHistory
      : undefined
    const contextWorkspace = nativeContext ? await this.toolScope?.workspaceFor?.(baseSessionId, options.signal) || {} : undefined
    const nextContextDigest = nativeContext ? contextHash({
      messages: contextHashes(snapshotMessages),
      toolHistory: meaningfulToolContext(contextToolHistory),
      workspace: contextWorkspace,
    }) : null
    const previousContextReference = nativeContext && state.contextReference && this.contextStore.has(state.contextReference.context_id)
      ? state.contextReference : null
    const reuseContext = Boolean(previousContextReference && state.contextDigest === nextContextDigest)
    const contextInput = nativeContext ? {
      sessionId: baseSessionId,
      messages: snapshotMessages,
      toolHistory: contextToolHistory,
      workspace: contextWorkspace,
    } : null
    const contextReference = nativeContext
      ? reuseContext
        ? this.contextStore.refresh(previousContextReference.context_id, contextInput)
        : this.contextStore.capture(contextInput)
      : null
    const contextChanged = Boolean(contextReference && !reuseContext)
    activity.emit('context.prepared', '已准备本轮上下文和输入', {
      promptChars: prompt.length, attachmentCount: attachments.length, nativeMcp,
      contextChanged, contextId: contextReference?.context_id,
    })

    // Native MCP tools already ran inside the completed web reply. A host
    // notice without new user input or effective context is not another task.
    if (nativeContext && state.bootstrapped && !prompt.trim() && !attachments.length && !contextChanged) {
      const text = '没有新的任务或上下文变更，本轮已结束。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // Compatibility routes keep their existing text-file transport for bulky
    // instructions and history. Native ChatGPT carries the tiny MCP notice in
    // the composer text, so refreshing DSH context never consumes file quota.
    const previousDelivered = Boolean(previousContextReference && this.contextStore.isDelivered(previousContextReference.context_id))
    const contextBase = contextChanged && previousDelivered ? previousContextReference.context_id : null
    let attachment = null
    // Gemini's composer uses a Quill editor and has no ChatGPT-style context
    // attachment workflow. Send the bounded, exact tool catalogue as text.
    const geminiFullContext = geminiText ? [
      flattenMessages(allMessages.filter(message => message.role === 'system')),
      toolContext,
      flattenMessages(userMessages.slice(0, -1)),
    ].filter(Boolean).join('\n\n') : ''
    const geminiToolUpdate = geminiText && updateTools ? toolContext : ''
    const composeGemini = background => {
      const value = [background ? `【DSH 会话上下文与授权工具】\n${background}` : '', prompt].filter(Boolean).join('\n\n')
      if (value.length > maxChars) throw new BridgeError('gemini-context-too-large', `Gemini 本轮上下文超过 ${maxChars} 字符；请减少工具或新建更短的会话，不能静默截断工具清单。`)
      return value
    }
    if (isMainChat && !nativeContext && !geminiText) {
      const background = [
        !state.contextDelivered ? flattenMessages(allMessages.filter((message) => message.role === 'system')) : '',
        updateTools ? toolContext : '',
        !state.contextDelivered ? flattenMessages(userMessages.slice(0, -1)) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      if (background) {
        attachment = {
          name: 'dsh-context.txt',
          content: `【背景上下文】以下是 DSH 的系统提示、工具清单与历史对话；请结合它回答输入框里的最后一条用户消息。\n\n${background}`,
        }
      }
    }
    const continuationMessage = contextReference
      ? prompt || (contextChanged
        ? 'DSH 上下文已更新。请应用增量规则，只继续尚未完成的步骤；任务已经完成时确认更新后结束。'
        : '请处理当前尚未完成的步骤。')
      : prompt
    const contextMessage = since => [
      contextNotice(contextReference, since),
      continuationMessage,
    ].filter(Boolean).join('\n\n')
    const message = geminiText
      ? composeGemini(state.contextDelivered ? geminiToolUpdate : geminiFullContext)
      : contextReference && !this.contextStore.isDelivered(contextReference.context_id)
        ? contextMessage(contextBase)
        : continuationMessage

    let reply = ''
    let streamedText = ''
    let lastSnapshot = ''
    let streamStarted = false
    let inputInterrupted = false
    const interrupt = new AbortController()
    const streamWeb = nativeMcp || geminiText
    const signal = streamWeb && options.signal ? AbortSignal.any([options.signal, interrupt.signal]) : streamWeb ? interrupt.signal : options.signal
    let unwatch
    let submittedState = {}
    const markSubmitted = (submitted = {}) => {
      submittedState = { ...submittedState, ...submitted }
      state.bootstrapped = true
      state.sentMessages = userMessages.length
      if (nativeContext || geminiText) state.sentUserKeys = userKeys
      if (!nativeContext) state.contextDelivered = !attachment || submittedState.contextAttachmentDelivered !== false
      if (withTools && state.contextDelivered) state.toolContext = toolContext
    }
    try {
      if (streamWeb && isMainChat) unwatch = this.toolScope?.watchUserInput?.(baseSessionId, () => {
        activity.emit('input.interrupted', '收到新的用户输入，正在中止上一轮等待')
        inputInterrupted = true; interrupt.abort()
      })
      let nextText = null
      let wake
      const publish = ({ text }) => {
        // Tool envelopes are emitted as DSH tool-call blocks after completion.
        // Do not leak a partial Gemini protocol prefix as a text block first.
        if (geminiText && String(text).trimStart().startsWith('<')) return
        // Do not persist an uninitialized answer as a partial assistant message
        // if the web model ignores bootstrap. Progress snapshots are cumulative;
        // the next update (or final reply) still contains this earlier text.
        if (contextReference && !this.contextStore.isDelivered(contextReference.context_id)) return
        nextText = streamPreview(text)
        const notify = wake
        wake = null
        notify?.()
      }
      const ask = () => this.session.ask(message, {
        activity,
        signal,
        sessionKey: sessionId,
        attachment,
        onSubmitted: markSubmitted,
        ...(contextReference ? {
          onConversation: info => {
            if (info.newConversation || info.reset) {
              this.contextStore.resetDelivery(contextReference.context_id, { sessionId: baseSessionId })
              state.contextReference = null
              state.contextDelivered = false
            }
          },
          prepareMessage: async info => {
            const freshConversation = info.newConversation || info.reset
            const needsContext = freshConversation || !this.contextStore.isDelivered(contextReference.context_id)
            activity.emit('message.prepared', '已确定要发送的网页消息和上下文引用', { needsContext, newConversation: freshConversation })
            return {
              text: needsContext ? contextMessage(freshConversation ? null : contextBase) : continuationMessage,
              // A fresh web conversation has none of the earlier user uploads,
              // even when this attempt contains only a context continuation.
              attachments: freshConversation
                ? await this.toolScope?.attachmentsFor?.(baseSessionId, userMessages) || []
                : attachments,
            }
          },
        } : {}),
        ...(geminiText ? { prepareMessage: info => ({
          text: composeGemini(info.newConversation || info.reset || !state.contextDelivered ? geminiFullContext : geminiToolUpdate),
        }) } : {}),
        ...(streamWeb ? { onProgress: publish } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...((this.settings.site === 'chatgpt' || this.dualReasoning) && !webModel ? { reasoning: options.model === `${this.modelId}-instant` ? 'off' : 'on' } : this.settings.site === 'chatgpt' && webModel ? { webModel } : {}),
      })
      const operation = this.toolScope && isMainChat ? this.toolScope.withSession(baseSessionId, ask, signal, { contextReference, activity }) : ask()
      let result
      if (streamWeb) {
        let done = false
        let failure
        const finished = operation.then(value => { result = value }, error => { failure = error }).finally(() => { done = true; const notify = wake; wake = null; notify?.() })
        while (!done || nextText !== null) {
          if (nextText !== null) {
            const text = nextText
            nextText = null
            const delta = snapshotDelta(lastSnapshot, text)
            if (delta !== null) lastSnapshot = text
            if (delta) {
              if (!streamStarted) { yield { type: 'block-start', index: 0, blockType: 'text' }; streamStarted = true }
              yield { type: 'text-delta', index: 0, text: delta }
              streamedText += delta
            }
          } else if (!done) await new Promise(resolve => { wake = resolve; if (done || nextText !== null) resolve() })
        }
        await finished
        if (failure) throw failure
      } else result = await operation
      reply = result.reply
      markSubmitted(result)
      if (contextReference) {
        state.contextDelivered = this.contextStore.isDelivered(contextReference.context_id)
        if (!state.contextDelivered) {
          throw new BridgeError('context-not-initialized', '网页模型未完整读取本轮 DSH 上下文；初始化未完成。请确认桥接插件已刷新并包含 dsh_get_context 后重试。')
        }
        state.contextReference = contextReference
        state.contextDigest = nextContextDigest
        state.contextDelivered = true
      }
    } catch (err) {
      if (inputInterrupted || err.code === 'web-generation-stopped' || err.code === 'aborted' || options.signal?.aborted) {
        if (err.code === 'web-generation-stopped') this.toolScope?.cancelSession?.(baseSessionId)
        if (streamStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } }
        yield { type: 'finish', reason: inputInterrupted && !options.signal?.aborted
          ? { kind: 'stop' }
          : { kind: 'aborted', failure: { code: 'ABORTED', message: err.code === 'web-generation-stopped' ? '网页生成已中止。' : '请求已中止。' } } }
        return
      }
      const error = new Error(err.code === 'attachment-quota-exceeded' ? err.message : `[${this.providerId}] ${err.code || 'error'}: ${err.message}`)
      error.cause = err
      throw error
    } finally { unwatch?.() }

    if (withTools) {
      const parsed = this.parseReply(reply)
      if (parsed.kind === 'calls' && parsed.calls.length > 0) {
        if (geminiText && streamStarted) throw new BridgeError('gemini-tool-protocol-conflict', 'Gemini 已流出正文后又返回工具协议；为避免混合执行，未调用任何工具。')
        const allowed = new Set(tools.map(tool => tool.name))
        const denied = parsed.calls.find(call => !allowed.has(call.name))
        if (denied) throw new BridgeError('tool-not-allowed', `网页模型请求了未授权的工具：${denied.name}。未执行任何工具。`)
        let index = 0
        for (const call of parsed.calls) {
          const id = `wb_${Date.now()}_${index}`
          const args = JSON.stringify(call.arguments || {})
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
          index += 1
        }
        yield { type: 'finish', reason: { kind: 'tool-use' } }
        return
      }
      if (parsed.kind === 'final') reply = parsed.text
    }

    if (!streamStarted) yield { type: 'block-start', index: 0, blockType: 'text' }
    {
      const rest = streamStarted ? snapshotDelta(lastSnapshot, reply) : reply
      if (rest) yield { type: 'text-delta', index: 0, text: rest }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
import { paidModelKey as paidKey } from './models/chatgpt.js'
