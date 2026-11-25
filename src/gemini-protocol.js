/** Strict Gemini text-tool protocol; no implicit execution from ordinary Markdown. */
const CALLS_OPEN = '<<<TOOL_CALLS>>>'
const CALLS_CLOSE = '<<<END_TOOL_CALLS>>>'
const FINAL_OPEN = '<<<FINAL>>>'
const FINAL_CLOSE = '<<<END_FINAL>>>'
const FINAL_OPEN_FALLBACK = '<<<'

function cleanFinal(text) {
  let value = String(text ?? '').trim()
  if (value.startsWith('<<<FINAL>>>')) value = value.slice('<<<FINAL>>>'.length)
  else if (value.startsWith('<<<')) value = value.slice(3)
  if (value.endsWith(FINAL_CLOSE)) value = value.slice(0, -FINAL_CLOSE.length)
  return value.trim()
}

function failure(message) {
  const error = new Error('gemini-tool-protocol: ' + message)
  error.code = 'gemini-tool-protocol'
  return error
}

/** Parse an explicit tool envelope only. Incomplete or malformed envelopes fail closed. */
export function parseGeminiReply(reply) {
  const text = String(reply ?? '').trim()
  if (text.startsWith(FINAL_OPEN) && text.endsWith(FINAL_CLOSE)) {
    return { kind: 'final', text: text.slice(FINAL_OPEN.length, -FINAL_CLOSE.length).trim() }
  }
  if (text.startsWith(FINAL_OPEN_FALLBACK) && text.includes(FINAL_CLOSE)) {
    return { kind: 'final', text: cleanFinal(text) }
  }
  if (!text.startsWith(CALLS_OPEN)) return { kind: 'text', text }
  if (!text.endsWith(CALLS_CLOSE)) throw failure('tool-call envelope is incomplete')

  const body = text.slice(CALLS_OPEN.length, -CALLS_CLOSE.length).trim()
  let parsed
  try { parsed = JSON.parse(body) }
  catch { throw failure('invalid JSON tool-call payload') }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) {
    throw failure('expected 1 to 16 tool calls in an array')
  }
  const calls = []
  const seen = new Set()
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.name !== 'string' || !/^[A-Za-z_][\w.-]{0,127}$/.test(item.name) ||
        !item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) {
      throw failure('each call must have a valid name and object arguments')
    }
    const key = JSON.stringify([item.name, item.arguments])
    if (seen.has(key)) throw failure('duplicate identical tool call')
    seen.add(key)
    calls.push({ name: item.name, arguments: item.arguments })
  }
  return { kind: 'calls', calls }
}
