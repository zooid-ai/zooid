export interface EnsureAdminOpts {
  homeserver: string
  username: string
  password: string
}

export interface EnsureAdminResult {
  created: boolean
  userId: string
}

export async function ensureAdminUser(
  opts: EnsureAdminOpts,
): Promise<EnsureAdminResult> {
  const r = await fetch(`${opts.homeserver}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      auth: { type: 'm.login.dummy' },
      username: opts.username,
      password: opts.password,
      inhibit_login: true,
    }),
  })
  if (r.ok) {
    const j = (await r.json()) as { user_id: string }
    return { created: true, userId: j.user_id }
  }
  const j = (await r.json()) as { errcode?: string; error?: string }
  if (j.errcode === 'M_USER_IN_USE') {
    const host = new URL(opts.homeserver).hostname
    return { created: false, userId: `@${opts.username}:${host}` }
  }
  throw new Error(
    `register ${opts.username}: ${r.status} ${j.errcode ?? ''} ${j.error ?? ''}`.trim(),
  )
}
