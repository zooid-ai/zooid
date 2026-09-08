import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node22',
    clean: true,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry: { 'zooid-tasks': 'src/extension.ts' },
    format: ['esm'],
    target: 'node22',
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    noExternal: [/.*/],
  },
])
