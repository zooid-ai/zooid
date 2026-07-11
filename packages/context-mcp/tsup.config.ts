import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  outDir: 'dist',
  // The bin is bind-mounted into agent containers that have no node_modules.
  // Inline its runtime deps so `node dist/bin.js` needs only Node builtins.
  // (@zooid/core is type-only here and erases at build; nothing else is needed.)
  noExternal: ['@modelcontextprotocol/sdk', 'zod'],
})
