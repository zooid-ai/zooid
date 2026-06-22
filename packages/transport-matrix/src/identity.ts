export const SLUG_RE = /^[a-z0-9-]+$/
export const AGENT_KEY_RE = /^[a-z0-9-]+$/

export const isValidSlug = (s: string): boolean => SLUG_RE.test(s)
export const isValidAgentKey = (s: string): boolean => AGENT_KEY_RE.test(s)

export function agentMxid(slug: string, agent: string, serverName: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${JSON.stringify(slug)}`)
  if (!isValidAgentKey(agent)) throw new Error(`invalid agent key: ${JSON.stringify(agent)}`)
  return `@${slug}.${agent}:${serverName}`
}

export function splitAgentLocalpart(localpart: string): { slug: string; agent: string } {
  const i = localpart.indexOf('.') // first dot is the boundary; slug/agent are dot-free
  if (i <= 0 || i === localpart.length - 1) throw new Error(`not a slug.agent localpart: ${localpart}`)
  return { slug: localpart.slice(0, i), agent: localpart.slice(i + 1) }
}

export function slugUserNamespace(slug: string, serverName: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${JSON.stringify(slug)}`)
  return `@${slug}\\..*:${serverName}` // escaped dot — exclusive to this slug's agents
}
