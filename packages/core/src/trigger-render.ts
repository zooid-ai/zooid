/**
 * Fill `${output}` in a trigger's `text:` template. Webhooks are the only
 * consumer — a scheduled trigger's `text:` is literal (nothing runs before
 * it) — see [[ZOD082]] §Design 4 / [[ZOD081]] §Design 2.
 *
 * The result is never re-scanned for `${output}`, so a payload that itself
 * contains the literal string `${output}` cannot cause recursive expansion.
 */
export function renderTriggerBody(template: string, output: string | undefined): string {
  return template.split('${output}').join(output ?? '')
}
