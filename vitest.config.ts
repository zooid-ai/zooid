import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'packages/server/**',
      'tests/**',
      '**/e2e.test.ts',
      '**/integration.test.ts',
      '**/node_modules/**',
    ],
  },
});
