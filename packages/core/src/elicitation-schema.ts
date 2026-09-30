import type { ElicitationSchema } from '@zooid/acp-client'

export type ElicitationContent = Record<string, string | number | boolean | string[]>
export type ElicitationValidation =
  | { ok: true; content: ElicitationContent }
  | { ok: false; errors: Record<string, string> }

type Prop = Record<string, unknown> & { type?: unknown }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const consts = (list: unknown): string[] =>
  Array.isArray(list) ? list.flatMap((o) => (isObj(o) && typeof o.const === 'string' ? [o.const] : [])) : []

function choicesOf(p: Prop): string[] | undefined {
  if (Array.isArray(p.enum)) return p.enum.filter((x): x is string => typeof x === 'string')
  if (Array.isArray(p.oneOf)) return consts(p.oneOf)
  return undefined
}

function itemChoicesOf(p: Prop): string[] | undefined {
  const items = p.items
  if (!isObj(items)) return undefined
  if (Array.isArray(items.anyOf)) return consts(items.anyOf)
  if (items.type === 'string' && Array.isArray(items.enum)) {
    return items.enum.filter((x): x is string => typeof x === 'string')
  }
  return undefined
}

const FORMAT: Record<string, (v: string) => boolean> = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => URL.canParse(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  'date-time': (v) => v.includes('T') && !Number.isNaN(Date.parse(v)),
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'u')
  } catch {
    return null
  }
}

/** Why a schema can't be rendered as a form. Empty means supported. */
export function unsupportedSchemaReasons(schema: unknown): string[] {
  if (!isObj(schema) || (schema.type !== undefined && schema.type !== 'object')) {
    return ['root: type must be "object"']
  }
  const props = schema.properties ?? {}
  if (!isObj(props)) return ['root: properties must be an object']
  const reasons: string[] = []
  for (const [key, raw] of Object.entries(props)) {
    const p = (isObj(raw) ? raw : {}) as Prop
    switch (p.type) {
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
        break
      case 'array':
        if (!itemChoicesOf(p)) reasons.push(`properties.${key}: unsupported multi-select items`)
        break
      default:
        reasons.push(`properties.${key}: unsupported type "${String(p.type)}"`)
    }
    if (typeof p.format === 'string' && !Object.hasOwn(FORMAT, p.format)) {
      reasons.push(`properties.${key}: unsupported format "${p.format}"`)
    }
    if (typeof p.pattern === 'string' && !safeRegExp(p.pattern)) {
      reasons.push(`properties.${key}: invalid pattern`)
    }
  }
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const r of required) {
    if (typeof r !== 'string' || !Object.hasOwn(props, r)) reasons.push(`required: "${String(r)}" is not a property`)
  }
  return reasons
}

function checkValue(p: Prop, v: unknown): string | undefined {
  switch (p.type) {
    case 'string': {
      if (typeof v !== 'string') return 'must be text'
      const choices = choicesOf(p)
      if (choices && !choices.includes(v)) return `must be one of: ${choices.join(', ')}`
      if (typeof p.minLength === 'number' && v.length < p.minLength) return `must be at least ${p.minLength} characters`
      if (typeof p.maxLength === 'number' && v.length > p.maxLength) return `must be at most ${p.maxLength} characters`
      if (typeof p.pattern === 'string' && !safeRegExp(p.pattern)?.test(v)) return 'has the wrong format'
      if (typeof p.format === 'string' && FORMAT[p.format] && !FORMAT[p.format]!(v)) return `must be a valid ${p.format}`
      return undefined
    }
    case 'integer':
    case 'number': {
      const label = p.type === 'integer' ? 'must be an integer' : 'must be a number'
      if (typeof v !== 'number' || !Number.isFinite(v)) return label
      if (p.type === 'integer' && !Number.isInteger(v)) return label
      if (typeof p.minimum === 'number' && v < p.minimum) return `must be ≥ ${p.minimum}`
      if (typeof p.maximum === 'number' && v > p.maximum) return `must be ≤ ${p.maximum}`
      return undefined
    }
    case 'boolean':
      return typeof v === 'boolean' ? undefined : 'must be true or false'
    case 'array': {
      const choices = itemChoicesOf(p) ?? []
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return 'must be a list of choices'
      if (v.some((x) => !choices.includes(x as string))) return `must only contain: ${choices.join(', ')}`
      if (new Set(v).size !== v.length) return 'must not repeat a choice'
      if (typeof p.minItems === 'number' && v.length < p.minItems) return `choose at least ${p.minItems}`
      if (typeof p.maxItems === 'number' && v.length > p.maxItems) return `choose at most ${p.maxItems}`
      return undefined
    }
  }
  return 'unsupported field'
}

/**
 * Validate a submitted answer against the request's original schema. Never
 * coerces: a value on the wire must already have the schema's type. Empty
 * values (undefined, null, '', []) count as "not answered".
 */
export function validateElicitationContent(schema: ElicitationSchema, content: unknown): ElicitationValidation {
  if (!isObj(content)) return { ok: false, errors: { _: 'content must be an object' } }
  const props = (schema.properties ?? {}) as Record<string, Prop>
  const required = new Set(schema.required ?? [])
  const errors: Record<string, string> = Object.create(null)
  const out: ElicitationContent = Object.create(null)
  for (const key of Object.keys(content)) {
    if (!Object.hasOwn(props, key)) errors[key] = 'unknown field'
  }
  for (const [key, p] of Object.entries(props)) {
    const v = content[key]
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    if (empty) {
      if (required.has(key)) errors[key] = 'required'
      continue
    }
    const err = checkValue(p, v)
    if (err) errors[key] = err
    else out[key] = v as ElicitationContent[string]
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, content: out }
}
