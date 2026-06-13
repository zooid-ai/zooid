import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  noExternal: [/^@zooid\//],
  banner: { js: '#!/usr/bin/env node' },
})
