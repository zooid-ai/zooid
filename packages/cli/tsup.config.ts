import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Self-bundle workspace deps so the published bin is a single file that
  // doesn't need any @zooid/budd-* packages installed alongside it.
  noExternal: [/^@zooid\/budd(-|$)/],
  banner: { js: '#!/usr/bin/env node' },
})
