import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  outDir: 'dist',
})
