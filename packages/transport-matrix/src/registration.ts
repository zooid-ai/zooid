import { stringify } from 'yaml'

export interface MatrixTransportConfig {
  id: string
  url: string
  homeserver: string
  asToken: string
  hsToken: string
  senderLocalpart: string
  /** Regex covering all bot users, e.g. `@.*:example.com` */
  userNamespace: string
}

export function renderRegistration(c: MatrixTransportConfig): string {
  return stringify(
    {
      id: c.id,
      url: c.url,
      as_token: c.asToken,
      hs_token: c.hsToken,
      sender_localpart: c.senderLocalpart,
      rate_limited: false,
      namespaces: {
        users: [{ exclusive: true, regex: c.userNamespace }],
        aliases: [],
        rooms: [],
      },
    },
    { defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN', singleQuote: true },
  )
}
