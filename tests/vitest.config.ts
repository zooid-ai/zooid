import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: '../packages/server/wrangler.toml',
        },
        miniflare: {
          d1Databases: ['DB'],
        },
      },
    },
  },
});
