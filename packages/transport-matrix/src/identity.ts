// A workstation id (and an agent key) must be "slug-shaped": kebab-case,
// MXID/alias-safe. SLUG_RE names the *format*; the domain noun is workstation.
export const SLUG_RE = /^[a-z0-9-]+$/
export const AGENT_KEY_RE = /^[a-z0-9-]+$/

export const isValidWorkstation = (s: string): boolean => SLUG_RE.test(s)
export const isValidAgentKey = (s: string): boolean => AGENT_KEY_RE.test(s)

export function agentMxid(workstation: string, agent: string, serverName: string): string {
  if (!isValidWorkstation(workstation))
    throw new Error(`invalid workstation: ${JSON.stringify(workstation)}`)
  if (!isValidAgentKey(agent)) throw new Error(`invalid agent key: ${JSON.stringify(agent)}`)
  return `@${workstation}.${agent}:${serverName}`
}

export function splitAgentLocalpart(localpart: string): { workstation: string; agent: string } {
  const i = localpart.indexOf('.') // first dot is the boundary; workstation/agent are dot-free
  if (i <= 0 || i === localpart.length - 1)
    throw new Error(`not a workstation.agent localpart: ${localpart}`)
  return { workstation: localpart.slice(0, i), agent: localpart.slice(i + 1) }
}

export function workstationUserNamespace(workstation: string, serverName: string): string {
  if (!isValidWorkstation(workstation))
    throw new Error(`invalid workstation: ${JSON.stringify(workstation)}`)
  return `@${workstation}\\..*:${serverName}` // escaped dot — exclusive to this workstation's agents
}
