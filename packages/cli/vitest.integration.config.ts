import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['src/**/integration.test.ts'],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: '../server/wrangler.toml',
        },
        miniflare: {
          d1Databases: ['DB'],
        },
      },
    },
  },
});
