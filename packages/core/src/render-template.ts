import { run, isCelError, type CelInput } from '@bufbuild/cel'
import type { MatchContext } from './match-expression.js'

// Non-greedy so `${a}...${b}` is two placeholders, not one spanning both.
const PLACEHOLDER_RE = /\$\{([\s\S]+?)\}/g

/**
 * Fill `${...}` placeholders in a trigger's `text:`. Each placeholder is a
 * CEL expression over the same bindings `match:` sees — one expression
 * language, not two. `${output}` is not a special case: `output` is just
 * another bound variable, so a whole-payload dump still works for senders we
 * control ([[ZOD081]] §2).
 *
 * An unresolvable placeholder (missing field, bad expression) renders as
 * empty rather than throwing or pasting an error object into a room — a bad
 * placeholder must not take the message down.
 *
 * The result is never re-scanned, so a payload that itself contains the
 * literal string `${...}` cannot inject a placeholder.
 */
export function renderTemplate(template: string, ctx: MatchContext): string {
  return template.replace(PLACEHOLDER_RE, (_match, expr: string) => {
    let result: unknown
    try {
      result = run(expr, { ...ctx } as Record<string, CelInput>)
    } catch {
      return ''
    }
    if (result === undefined || isCelError(result)) return ''
    return String(result)
  })
}
