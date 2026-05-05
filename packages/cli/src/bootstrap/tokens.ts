import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Tokens {
  asToken: string
  hsToken: string
}

const AS_RE = /^MATRIX_AS_TOKEN=(.+)$/m
const HS_RE = /^MATRIX_HS_TOKEN=(.+)$/m

function genToken(prefix: string): string {
  return `${prefix}-${randomBytes(24).toString('hex')}`
}

export function readTokens(envPath: string): Tokens | null {
  if (!existsSync(envPath)) return null
  const text = readFileSync(envPath, 'utf8')
  const as = text.match(AS_RE)?.[1]
  const hs = text.match(HS_RE)?.[1]
  if (!as && !hs) return null
  if (!as || !hs) {
    throw new Error(
      `${envPath}: missing MATRIX_AS_TOKEN or MATRIX_HS_TOKEN. Delete the file to regenerate, or restore the missing value.`,
    )
  }
  return { asToken: as, hsToken: hs }
}

export function ensureTokens(envPath: string): Tokens {
  const existing = readTokens(envPath)
  if (existing) return existing
  const tokens: Tokens = { asToken: genToken('as'), hsToken: genToken('hs') }
  mkdirSync(dirname(envPath), { recursive: true })
  const previous = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const next =
    previous.trimEnd() +
    (previous ? '\n' : '') +
    `MATRIX_AS_TOKEN=${tokens.asToken}\nMATRIX_HS_TOKEN=${tokens.hsToken}\n`
  writeFileSync(envPath, next, { mode: 0o600 })
  return tokens
}
