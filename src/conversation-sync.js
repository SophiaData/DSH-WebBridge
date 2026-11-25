import { createHash } from 'node:crypto'
import { BridgeError } from './envelope.js'
import { domToMarkdown } from './markdown.js'

function stripProtocolMarkers(text) {
  let value = String(text ?? '')
  if (/^<<</.test(value)) value = value.slice(3)
  if (value.startsWith(' 你好')) value = value.slice(1)
  return value
    .replace(/<<<+\s*(?:END_FINAL|END_TOOL_CALLS|END_NEXUS_TOOLS)\s*>>>?$/i, '')
    .trim()
}

/** Read visible user and assistant messages from this conversation's DOM. */
function readWebTurns(serialize) {
  const visible = node => typeof node.checkVisibility !== 'function' ||
    node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  const rows = Array.from(document.querySelectorAll(
    '[data-content-search-unit-key$=":user"],[data-content-search-unit-key$=":assistant"]'
  )).filter(visible)
  const messages = []
  const seen = new Set()
  for (const row of rows) {
    const key = row.getAttribute('data-content-search-unit-key') || ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    const role = key.endsWith(':user') ? 'user' : 'assistant'
    if (role === 'user') {
      const body = row.querySelector('[data-search-result-target]') || row
      const text = String(body.innerText || body.textContent || '').trim()
      if (text) messages.push({ role, key, text })
      continue
    }
    const candidates = Array.from(row.querySelectorAll(
      '[data-markdown-text-style="assistant-message"],[class*="MarkdownRoot"]'
    )).filter(visible)
    const roots = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)))
    const body = row.querySelector('[data-response-body]') || row
    const parts = roots.length ? roots : [body]
    const text = parts.map(node => String(node.innerText || node.textContent || '').trim()).filter(Boolean).join('\n\n')
    const markdown = parts.map(node => serialize(node)).filter(Boolean).join('\n\n')
    if (text) messages.push({ role, key, text, markdown })
  }
  const stop = Array.from(document.querySelectorAll(
    'button[data-testid="stop-button"],button[aria-label="停止"],button[aria-label="停止生成"],button[aria-label="Stop generating"]'
  )).some(visible)
  return { url: location.href, title: document.title, messages, streaming: stop }
}

export function buildConversationReadExpression() {
  return '(' + readWebTurns.toString() + ')(' + domToMarkdown.toString() + ')'
}

function textOf(message) {
  if (typeof message.content === 'string') return message.content
  return (Array.isArray(message.content) ? message.content : [])
    .filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
}

function normalize(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

function webUserText(text) {
  let value = stripProtocolMarkers(text)
  // Historical turns carry the old plugin name; normalize both spellings.
  if (/^调用 (?:WebBridge|Nexus) DSH 的 dsh_get_context，参数为 /.test(value)) {
    const boundary = value.indexOf('\n\n')
    value = boundary < 0 ? '' : value.slice(boundary + 2).trim()
  }
  if (/^DSH 上下文已更新。请应用增量规则/.test(value) ||
      /^请处理当前尚未完成的步骤。?$/.test(value)) return ''
  return value.replace(/^(?:WebBridge|Nexus) DSH\s*\n/, '').trim()
}

function webId(url, entry, index) {
  const hex = createHash('sha256').update([url, entry.key || index, entry.role].join('|')).digest('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32)
}

function same(local, web) {
  if (local.role !== web.role) return false
  if (local.id && local.id === web.id) return true
  const a = normalize(local.text)
  const b = normalize(web.text)
  const marked = normalize(web.markdown)
  if (!a || !b) return false
  if (a === b || a === marked) return true
  // A web bootstrap notice or an app mention can precede the human prompt.
  if (web.role === 'user') return a.length >= 6 && b.endsWith(a)
  // Browser-rendered Markdown may omit punctuation or markup from source text.
  return a.length >= 30 && (b === a.replace(/[*_\x60]/g, '') || marked === a.replace(/[*_\x60]/g, ''))
}

/** Plan a safe missing suffix without reordering the existing local history. */
export function planConversationSync(localMessages, webMessages, url) {
  const web = webMessages.map((message, index) => ({
    role: message.role,
    key: message.key || '',
    text: message.role === 'user' ? webUserText(message.text) : stripProtocolMarkers(message.text),
    markdown: message.role === 'assistant' ? String(message.markdown || '').trim() : '',
    id: webId(url, message, index),
  })).filter(message => ['user', 'assistant'].includes(message.role) && message.text)
  const local = localMessages.filter(message =>
    (message.role === 'user' && message.source?.kind === 'user' ||
     message.role === 'assistant' && message.source?.kind === 'model') && normalize(textOf(message))
  ).map(message => ({ id: message.id, role: message.role, text: textOf(message) }))
  if (!web.length) throw new BridgeError('sync-no-messages', '网页没有可读取的聊天消息，未修改本地会话。')
  let anchor = -1
  let partialReply = -1
  if (local.length) {
    anchor = web.findLastIndex(entry => same(local[local.length - 1], entry))
    // A failed transport can leave only the beginning of a finished web reply
    // in DSH. Recover its tail only when the immediately preceding user matches.
    if (anchor < 0 && local.length >= 2 && local[local.length - 1].role === 'assistant') {
      const last = local[local.length - 1]
      const prefix = normalize(last.text)
      partialReply = web.findLastIndex((entry, index) =>
        index > 0 && entry.role === 'assistant' && prefix.length >= 30 &&
        normalize(entry.text).startsWith(prefix) &&
        normalize(entry.text).length > prefix.length + 12 &&
        same(local[local.length - 2], web[index - 1])
      )
      if (partialReply >= 0) anchor = partialReply - 1
    }
    if (anchor < 0) {
      throw new BridgeError('sync-no-overlap', '网页和本地最近一条消息无法对应。为避免混入其他聊天，未写入本地历史。')
    }
  }
  const ids = new Set(local.map(message => message.id))
  const missing = web.slice(anchor + 1).filter(message => !ids.has(message.id) &&
    !local.some(existing => same(existing, message))).map(message => {
      if (message !== web[partialReply]) return message
      const existing = local[local.length - 1].text
      const tail = message.text.startsWith(existing) ? message.text.slice(existing.length).trim() : ''
      return {
        ...message,
        text: '【从网页恢复的后续回复】\n\n' + (tail || message.text),
        markdown: '',
      }
    })
  return { visible: web.length, matched: anchor + 1, missing }
}

/** Write missing turns through the DSH session's durable event log. */
export function appendMissingWebTurns(session, boundary, missing, { provider, model }) {
  if (!missing.length) return 0
  if (boundary?.openTurnStartSeq != null) {
    throw new BridgeError('session-busy', '本地会话正在运行，暂时不能补同步。')
  }
  let turn = boundary?.lastTurn || 0
  let group = []
  const groups = []
  for (const message of missing) {
    if (message.role === 'user' && group.length) { groups.push(group); group = [] }
    group.push(message)
  }
  if (group.length) groups.push(group)
  const events = []
  for (const entries of groups) {
    turn++
    events.push(['turn/start', { turn }])
    events.push(['step/start', { turn, step: 0 }])
    for (const entry of entries) {
      const body = entry.role === 'assistant' ? entry.markdown || entry.text : entry.text
      const message = {
        id: entry.id, role: entry.role, content: [{ type: 'text', text: body }],
        source: entry.role === 'user' ? { kind: 'user' } : { kind: 'model', provider, model },
      }
      if (entry.role === 'user') events.push(['user/message', message, { surfaceOp: 'append' }])
      else {
        const time = Date.now()
        events.push(['assistant/message', {
          turn, step: 0, message,
          stream: [
            { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
            { type: 'chunk', time, chunk: { type: 'text-delta', index: 0, text: body } },
            { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: body } } },
            { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
          ],
        }, { surfaceOp: 'append' }])
      }
    }
    events.push(['step/end', { turn, step: 0 }])
    events.push(['turn/end', { turn, reason: { kind: 'completed' } }])
  }
  session.append(events)
  return missing.length
}
