import { defineConfig } from 'tsup'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'

export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  noExternal: [/^@zooid\//],
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    // Workspace root is z/. CLI cwd at build time is zooid/packages/cli.
    const webSrc = join(process.cwd(), '..', '..', '..', 'zoon', 'packages', 'web', 'dist')
    if (!existsSync(webSrc)) {
      execSync('pnpm -C ../../../zoon/packages/web build', { stdio: 'inherit' })
    }
    const webDest = join(process.cwd(), 'dist', 'web')
    mkdirSync(webDest, { recursive: true })
    cpSync(webSrc, webDest, { recursive: true })
  },
})
