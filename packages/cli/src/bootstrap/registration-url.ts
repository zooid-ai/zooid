export function deriveRegistrationUrl(opts: { port?: number; advertise_url?: string }): string {
  if (opts.port != null && opts.advertise_url != null)
    throw new Error("registration url: 'port' and 'advertise_url' are mutually exclusive")
  if (opts.advertise_url != null) return opts.advertise_url
  if (opts.port != null) return `http://host.docker.internal:${opts.port}`
  throw new Error('registration url: need port or advertise_url')
}
