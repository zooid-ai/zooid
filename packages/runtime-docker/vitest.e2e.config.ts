import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000, // image build can take a while on a cold cache
    // e2e tests hit a real Docker daemon — run serially to avoid port conflicts
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
