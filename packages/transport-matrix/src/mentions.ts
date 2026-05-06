export interface MaybeMessage {
  content?: {
    'm.mentions'?: { user_ids?: string[] }
    body?: string
    formatted_body?: string
  }
}

const MATRIX_TO_RE = /https:\/\/matrix\.to\/#\/(@[^"<>\s]+)/g
const RAW_USER_RE = /(@[A-Za-z0-9._\-=/+]+:[A-Za-z0-9.\-]+)/g

export function extractMentions(event: MaybeMessage): string[] {
  const out = new Set<string>()
  const c = event.content ?? {}
  for (const id of c['m.mentions']?.user_ids ?? []) out.add(id)
  if (c.formatted_body) {
    for (const m of c.formatted_body.matchAll(MATRIX_TO_RE)) {
      out.add(decodeURIComponent(m[1]))
    }
  }
  if (c.body && out.size === 0) {
    for (const m of c.body.matchAll(RAW_USER_RE)) out.add(m[1])
  }
  return [...out]
}

/**
 * Remove a single user-id mention from a message body. Strips the raw
 * `@local:server` form and collapses any whitespace that the strip leaves
 * behind. Other users' mentions are preserved verbatim so the agent can
 * reason about them.
 */
export function stripMention(body: string, userId: string): string {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match optional surrounding whitespace so we don't leave double spaces.
  const re = new RegExp(`\\s*${escaped}\\s*`, 'g')
  return body.replace(re, ' ').replace(/\s+/g, ' ').trim()
}
