/**
 * Mode A+ — let the web model call DSH tools through a text protocol.
 *
 * The contract is docs/PROTOCOL.md. The important property: this loop never
 * executes anything itself. It parses tool calls and hands them to `executeTool`,
 * which in the plugin is `ctx.tools.execute()` — so DSH policy, approval and
 * audit still decide what actually runs.
 */

const CALLS_OPEN = '<<<TOOL_CALLS>>>'
const CALLS_CLOSE = '<<<END_TOOL_CALLS>>>'
const FINAL_OPEN = '<<<FINAL>>>'
const FINAL_CLOSE = '<<<END_FINAL>>>'

/**
 * Extract the final answer or the tool calls from one model reply.
 *
 * Models do not share one tool-call dialect, so parsing accepts, in order:
 *   1. our explicit delimiters
 *   2. <tool_call> blocks
 *   3. a fenced ```json block holding an array or object
 *   4. a bare JSON array/object that actually carries name + arguments
 * A reply with no call markers is returned as `text`: the loop decides whether
 * that is the final answer (work has started) or a protocol violation (no work
 * has started yet).
 */
export function parseReply(text) {
  const raw = String(text || '')

  const finalBlock = extractFinal(raw)
  if (finalBlock !== null) return { kind: 'final', text: finalBlock }

  const calls = extractCalls(raw)
  if (calls.length > 0) return { kind: 'calls', calls }

  return { kind: 'text', text: raw.trim() }
}

function extractFinal(raw) {
  const start = raw.indexOf(FINAL_OPEN)
  if (start === -1) return null
  const body = raw.slice(start + FINAL_OPEN.length)
  const end = body.indexOf(FINAL_CLOSE)
  return (end === -1 ? body : body.slice(0, end)).trim()
}

function extractCalls(raw) {
  const blocks = []

  const delimited = sliceBetween(raw, CALLS_OPEN, CALLS_CLOSE)
  if (delimited !== null) blocks.push(delimited)

  const xml = raw.match(/<tool_call>([\s\S]*?)<\/tool_call>/gi) || []
  for (const block of xml) blocks.push(block.replace(/<\/?tool_call>/gi, ''))

  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/g) || []
  for (const block of fenced) blocks.push(block.replace(/```(?:json|JSON)?/g, '').replace(/```/g, ''))

  if (blocks.length === 0) blocks.push(raw)

  for (const block of blocks) {
    const calls = parseCalls(block)
    if (calls.length > 0) return calls
  }
  return []
}

function sliceBetween(raw, open, close) {
  const start = raw.indexOf(open)
  if (start === -1) return null
  const rest = raw.slice(start + open.length)
  const end = rest.indexOf(close)
  return end === -1 ? rest : rest.slice(0, end)
}

function parseCalls(body) {
  const candidates = [body]
  const arrayish = body.match(/\[[\s\S]*\]/)
  if (arrayish) candidates.push(arrayish[0])
  const objectish = body.match(/\{[\s\S]*\}/)
  if (objectish) candidates.push(objectish[0])

  for (const candidate of candidates) {
    const parsed = tryJson(candidate)
    if (!parsed) continue
    const list = Array.isArray(parsed) ? parsed : parsed.tool_calls ? parsed.tool_calls : [parsed]
    const calls = list
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const fn = item.function && typeof item.function === 'object' ? item.function : item
        const name = typeof fn.name === 'string' ? fn.name : null
        if (!name) return null
        let args = fn.arguments
        if (typeof args === 'string') {
          const parsedArgs = tryJson(args)
          // Models often put a single scalar where the object belongs
          // ("arguments": "E:\\path"). Keep it so the caller can map it onto
          // the tool's only required parameter instead of silently dropping it.
          args = parsedArgs ?? { __scalar: args }
        }
        return { name, arguments: args && typeof args === 'object' ? args : { __scalar: args } }
      })
      .filter(Boolean)
    if (calls.length > 0) return calls
  }
  return []
}

/**
 * Repair the two malformed-JSON shapes seen in practice before giving up:
 * an unescaped backslash inside a Windows path, and trailing junk after the
 * closing bracket.
 */
function tryJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {}
  const repaired = raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
  try {
    return JSON.parse(repaired)
  } catch {
    return null
  }
}

/**
 * A registry schema is either a full JSON Schema or the plugin's flat DSL map.
 * Normalize both so tool hints and required-name derivation stay correct after
 * host registration starts projecting JSON Schema.
 */
function parameterEntries(definition) {
  const source = definition?.parameters || {}
  const isJsonSchema = source?.type === 'object' && source.properties && typeof source.properties === 'object'
  return {
    entries: isJsonSchema ? Object.entries(source.properties) : Object.entries(source),
    requiredNames: isJsonSchema && Array.isArray(source.required) ? source.required : null,
  }
}

/**
 * Nexus-style meta tools: instead of injecting every tool schema into the web
 * chat prompt, expose two stable tools and let the model discover what it needs.
 *
 * This is our adaptation of the pattern in Nexus (`nexus_discover_tools` +
 * `nexus_run_script`), not something Nexus does for web models — Nexus speaks
 * MCP natively. Kept deliberately tiny: two names, two small schemas.
 */
export function createMetaTools(catalog) {
  const toolDefs = [
    {
      name: 'discover_tools',
      description: '按关键词查找可用的本机工具，返回工具名、说明与参数表。',
      parameters: { query: { type: 'string', required: true, description: '关键词，如 file / read / 文件' } },
    },
    {
      name: 'run_tool',
      description: '执行一个已发现的工具。arguments 必须是该工具参数的 JSON 对象。',
      parameters: {
        tool: { type: 'string', required: true, description: '工具名' },
        arguments: { type: 'object', description: '工具参数对象' },
      },
    },
  ]

  const discover = (query) => {
    const needle = String(query || '').toLowerCase()
    return catalog
      .filter((definition) => {
        if (!needle) return true
        return (
          definition.name.toLowerCase().includes(needle) ||
          String(definition.description || '').toLowerCase().includes(needle)
        )
      })
      .slice(0, 8)
      .map((definition) => {
        const { entries, requiredNames } = parameterEntries(definition)
        return {
          name: definition.name,
          description: String(definition.description || '').split('\n')[0].slice(0, 120),
          parameters: Object.fromEntries(entries.map(([key, spec]) => [
            key,
            {
              type: spec?.type || 'string',
              required: requiredNames ? requiredNames.includes(key) : Boolean(spec?.required),
            },
          ])),
        }
      })
  }

  const execute = async (call, execReal) => {
    const args = call.arguments || {}
    if (call.name === 'discover_tools') {
      const found = discover(args.query)
      return { ok: true, body: JSON.stringify({ count: found.length, tools: found }, null, 2) }
    }
    if (call.name === 'run_tool') {
      const target = catalog.find((definition) => definition.name === args.tool)
      if (!target) {
        return { ok: false, body: `unknown-tool: "${args.tool}" is not in the authorized catalog` }
      }
      let inner = args.arguments
      if (typeof inner === 'string') inner = tryJson(inner) ?? { __scalar: inner }
      const normalized = normalizeCall({ name: target.name, arguments: inner ?? {} }, catalog)
      return execReal(normalized)
    }
    return { ok: false, body: `unknown-meta-tool: "${call.name}"` }
  }

  return { toolDefs, execute }
}

/** Keep failure evidence short but present: an ok:false with no reason is useless. */
function clip(value, limit = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Models routinely collapse a one-parameter call into a bare value:
 *   {"name":"read","arguments":"E:\\path"}  instead of  {"file_path":"E:\\path"}
 * Map that onto the tool's single required parameter instead of executing with
 * an empty argument object and reporting a confusing validation error.
 */
export function normalizeCall(call, toolDefs) {
  const args = call?.arguments
  if (!args || typeof args !== 'object') return call
  const keys = Object.keys(args)
  if (keys.length !== 1 || keys[0] !== '__scalar') return call

  const definition = toolDefs.find((entry) => entry.name === call.name)
  const { entries, requiredNames } = parameterEntries(definition)
  const required = entries
    .filter(([key, spec]) => requiredNames ? requiredNames.includes(key) : Boolean(spec?.required))
    .map(([key]) => key)
  const all = entries.map(([key]) => key)
  const target = required.length === 1 ? required[0] : all.length === 1 ? all[0] : null
  if (!target) return call
  return { ...call, arguments: { [target]: args.__scalar } }
}

/** Render the compact tool list the web model is allowed to use. */
export function renderToolList(toolDefs) {
  const compact = toolDefs.map((definition) => {
    const source = definition.parameters || {}
    // Registry schemas arrive as full JSON Schema objects, not the flat DSL
    // form: iterate the real parameters from .properties instead of turning
    // the wrapper keys (type/properties/required) into bogus arguments.
    const isJsonSchema = source?.type === 'object' && source.properties && typeof source.properties === 'object'
    const entries = isJsonSchema ? Object.entries(source.properties) : Object.entries(source)
    const requiredNames = isJsonSchema && Array.isArray(source.required) ? source.required : null
    const parameters = Object.fromEntries(entries.map(([key, spec]) => {
      const parameter = { type: spec?.type || 'string' }
      if (spec?.description) parameter.description = String(spec.description).split('\n')[0].slice(0, 120)
      const isRequired = requiredNames ? requiredNames.includes(key) : spec?.required === true
      if (isRequired) parameter.required = true
      return [key, parameter]
    }))
    return {
      name: definition.name,
      description: String(definition.description || '').split('\n')[0].slice(0, 160),
      parameters,
    }
  })
  return JSON.stringify(compact)
}

export function composeMessage({ system, toolDefs, task }) {
  const compact = JSON.parse(renderToolList(toolDefs))
  // Teach the exact reply shapes with a copyable example built from the first
  // real tool: models comply with a format they can see, not one they must
  // guess (the webagent lesson: explicit format + worked example).
  const example = compact.length
    ? JSON.stringify([{
        name: compact[0].name,
        arguments: Object.fromEntries(
          Object.entries(compact[0].parameters || {}).map(([key, spec]) => [key, `<${spec?.type || 'string'}>`]),
        ),
      }])
    : '[]'
  const defaultSystem = [
    'You are an assistant running on the user local machine.',
    'You can only affect this machine through the tools listed below.',
    'Your built-in website tools (code sandboxes, web search and the like) run on the website\u2019s own servers and cannot touch this machine: the tool-call block below is the ONLY way to read or change anything locally.',
    'Reply with exactly one of these two blocks, and nothing else:',
    '1) To request tools:',
    '<<<TOOL_CALLS>>>',
    '[{"name":"<a tool from the list>","arguments":{ ... }}]',
    '<<<END_TOOL_CALLS>>>',
    '2) When the task is done:',
    '<<<FINAL>>>',
    '<your final answer in plain text>',
    '<<<END_FINAL>>>',
    'Example for the first tool:',
    '<<<TOOL_CALLS>>>',
    example,
    '<<<END_TOOL_CALLS>>>',
    'Never invent tool results: after a tool call, wait for the <<<TOOL_RESULT>>> block and continue from it. Do not perform destructive operations unrelated to the task.',
  ].join('\n')
  return [
    '<<<NEXUS_SYSTEM>>>',
    system || defaultSystem,
    '<<<END_NEXUS_SYSTEM>>>',
    '',
    '<<<NEXUS_TOOLS>>>',
    renderToolList(toolDefs),
    '<<<END_NEXUS_TOOLS>>>',
    '',
    '<<<NEXUS_TASK>>>',
    task,
    '<<<END_NEXUS_TASK>>>',
  ].join('\n')
}

export function renderToolResult({ id, name, ok, body }) {
  // Tool bodies from the registry can carry harness context-update sections
  // next to the business result; the web chat needs neither, and session
  // details have no business leaving the machine.
  const trimmed = String(body ?? '').split('[DSH context updates]')[0].trimEnd()
  const clipped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n[truncated]` : trimmed
  return [`<<<TOOL_RESULT id="${id}" name="${name}" ok="${ok ? 'true' : 'false'}">>>`, clipped, '<<<END_TOOL_RESULT>>>'].join('\n')
}

/**
 * Run the protocol loop.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {Array} input.toolDefs
 * @param {(message: string) => Promise<string>} input.send
 * @param {(call: {name: string, arguments: object}) => Promise<{ok: boolean, body: string}>} input.executeTool
 * @param {number} [input.maxTurns]
 * @param {(line: string) => void} [input.log]
 * @param {AbortSignal} [input.signal]
 */
export async function runAgentLoop(input) {
  const { task, toolDefs, send, executeTool, maxTurns = 6, log = () => {}, signal } = input
  const allowed = new Set(toolDefs.map((definition) => definition.name))
  const turns = []
  const seen = new Map()
  const history = []

  let message = composeMessage({ toolDefs, task })
  let deadTurns = 0

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return { final: '', turns, stopReason: 'aborted' }

    const reply = await send(history.length === 0 ? message : `${message}\n\n${history.join('\n\n')}`)
    const parsed = parseReply(reply)

    if (parsed.kind === 'final') {
      return { final: parsed.text, turns, stopReason: 'final' }
    }

    if (parsed.kind === 'text') {
      // No call markers. Once work has started this is the model answering in
      // prose, which is a perfectly good ending; before that it ignored the
      // protocol, so ask once more before degrading.
      if (turns.length > 0) return { final: parsed.text, turns, stopReason: 'final' }
      log(`[webbridge] turn ${turn}: reply has no tool call and no work has started`)
      history.push('<<<PROTOCOL_ERROR>>>reply has neither a tool call nor a final block; follow the protocol<<<END_PROTOCOL_ERROR>>>')
      deadTurns += 1
      if (deadTurns >= 2 || turn === maxTurns) return { final: parsed.text, turns, stopReason: 'degraded' }
      continue
    }

    const results = []
    let successes = 0
    for (let index = 0; index < parsed.calls.length; index++) {
      const rawCall = parsed.calls[index]
      const call = normalizeCall(rawCall, toolDefs)
      const id = `${turn}.${index + 1}`
      const digestKey = `${call.name}:${JSON.stringify(call.arguments)}`
      const repeat = (seen.get(digestKey) || 0) + 1
      seen.set(digestKey, repeat)

      if (!allowed.has(call.name)) {
        results.push(renderToolResult({ id, name: call.name, ok: false, body: 'tool-not-allowed: this tool is not in the authorized list' }))
        turns.push({ turn, id, tool: call.name, ok: false, code: 'tool-not-allowed' })
        continue
      }
      if (repeat >= 2) {
        results.push(renderToolResult({ id, name: call.name, ok: false, body: 'duplicate-call: this exact call was already made; change the arguments or finish' }))
        turns.push({ turn, id, tool: call.name, ok: false, code: 'duplicate-call' })
        continue
      }

      try {
        const outcome = await executeTool(call)
        const ok = outcome.ok !== false
        results.push(renderToolResult({ id, name: call.name, ok, body: outcome.body }))
        turns.push({ turn, id, tool: call.name, ok, ...(ok ? {} : { detail: clip(outcome.body) }) })
        if (ok) successes += 1
      } catch (err) {
        results.push(renderToolResult({ id, name: call.name, ok: false, body: `${err.code || 'error'}: ${err.message}` }))
        turns.push({ turn, id, tool: call.name, ok: false, code: err.code || 'error', detail: clip(err.message) })
      }
    }

    history.push(results.join('\n\n'))
    deadTurns = successes === 0 ? deadTurns + 1 : 0
    if (deadTurns >= 2) return { final: '', turns, stopReason: 'no-progress' }
  }

  return { final: '', turns, stopReason: 'max-turns' }
}
