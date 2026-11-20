/**
 * Local `defineTool`.
 *
 * The shipped `@deepseek-ai/dsh-tools` package cannot be imported from a bundle
 * that is *linked* from outside the DSH installation: Node resolves the bare
 * specifier from the bundle's real path, which is not inside the install tree.
 * Rather than copying host packages into the plugin, we re-create the only part
 * we used — argument validation wrapped around the caller's execute — and pass
 * the resulting plain definition to `ctx.tools.register`, which is the same
 * object shape the registry expects.
 */

export function defineTool(definition) {
  const parameters = definition.parameters || {}
  // The registry projects `parameters` to providers verbatim, so it must be a
  // real JSON Schema: a flat DSL map leaks `required: true` into the schema and
  // a DSL property literally named `type` becomes the root `type` keyword, which
  // strict providers reject ("Invalid schema for function ...").
  const schema = dslToJsonSchema(parameters)
  const userExecute = definition.execute

  const validate = (args) => {
    const violations = []
    const input = args && typeof args === 'object' ? args : {}
    for (const [key, spec] of Object.entries(parameters)) {
      const value = input[key]
      const type = spec?.type
      if (value === undefined || value === null || value === '') {
        if (spec?.required) violations.push(`${key} is required`)
        continue
      }
      if (type === 'string' && typeof value !== 'string') violations.push(`${key} must be a string`)
      if ((type === 'number' || type === 'integer') && typeof value !== 'number') violations.push(`${key} must be a number`)
      if (type === 'boolean' && typeof value !== 'boolean') violations.push(`${key} must be a boolean`)
      if (type === 'array' && !Array.isArray(value)) violations.push(`${key} must be an array`)
      if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) violations.push(`${key} must be an object`)
    }
    return violations
  }

  return {
    ...definition,
    parameters: schema,
    async execute(args, exec) {
      const violations = validate(args)
      if (violations.length > 0) {
        const err = new Error(`Invalid arguments for tool "${definition.name}": ${violations.join('; ')}`)
        err.code = 'invalid-arguments'
        throw err
      }
      return userExecute(args, exec)
    },
  }
}

/** Convert the DSH parameter DSL into JSON Schema for MCP clients. */
export function dslToJsonSchema(parameters = {}) {
  // Agent-scoped DSH schemas are already JSON Schema. Converting them again
  // would advertise "type", "properties", and "required" as tool arguments.
  if (parameters?.type === 'object' && parameters.properties && typeof parameters.properties === 'object') return parameters
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    const property = {}
    if (spec?.type) property.type = spec.type === 'integer' ? 'integer' : spec.type
    if (spec?.description) property.description = spec.description
    if (spec?.enum) property.enum = spec.enum
    if (spec?.items) {
      property.items = spec.items.type ? { type: spec.items.type } : dslToJsonSchema(spec.items.parameters || {})
    }
    properties[key] = property
    if (spec?.required) required.push(key)
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}
