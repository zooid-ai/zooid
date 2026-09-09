import { parse, run, type CelInput } from '@bufbuild/cel'

export interface MatchContext {
  event: string | undefined
  body: unknown
  headers: Record<string, string>
  output: string
}

/** Parse-check an expression. Throws on a syntax error, so a typo fails at config load. */
export function compileMatch(expr: string): string {
  parse(expr)
  return expr
}

/**
 * Only an actual `true` fires. Everything else is "no match":
 * - a CelError value (missing field, undeclared variable) — the library
 *   returns these rather than throwing, and a merged-PR filter legitimately
 *   errors on every issues delivery;
 * - a truthy non-boolean (a string, a number), which must never be coerced;
 * - a throw.
 * Failing closed matters more here than anywhere else in the ingress: this is
 * the only place an operator's typo could otherwise open a filter.
 */
export function evaluateMatch(expr: string, ctx: MatchContext): boolean {
  try {
    const result = run(expr, { ...ctx } as Record<string, CelInput>)
    return result === true
  } catch {
    return false
  }
}
