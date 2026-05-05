import { rmSync } from 'node:fs'

export default async function globalTeardown(): Promise<void> {
  const ctx = globalThis.__ZOOID_DEV__
  if (!ctx) return
  await ctx.handle.stop().catch(() => {})
  rmSync(ctx.workDir, { recursive: true, force: true })
  rmSync(ctx.dataDir, { recursive: true, force: true })
}
