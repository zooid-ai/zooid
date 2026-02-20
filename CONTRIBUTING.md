# Contributing to Zooid

Thanks for your interest in contributing to Zooid! This guide will help you get set up and familiar with the codebase.

## Prerequisites

- **Node.js** 20+
- **pnpm** 10.7+ (`corepack enable && corepack prepare pnpm@10.7.0 --activate`)

## Getting started

```bash
git clone https://github.com/zooid-ai/zooid.git
cd zooid
pnpm install
pnpm build
pnpm test
```

## Project structure

Monorepo with packages under `packages/`:

| Package             | Description                   |
| ------------------- | ----------------------------- |
| `packages/types`    | Shared TypeScript types       |
| `packages/ui`       | Svelte component library      |
| `packages/sdk`      | Client SDK (`ZooidClient`)    |
| `packages/web`      | Web app (Svelte + Vite)       |
| `packages/server`   | Cloudflare Worker (Hono + D1) |
| `packages/cli`      | `npx zooid` CLI               |
| `packages/homepage` | Landing page                  |

Dependency order: `types` → `ui` → `sdk` → `web` → `server` → `cli`

## Running tests

```bash
# Unit tests (SDK, CLI, types — runs via root vitest)
pnpm test

# Server tests (requires Cloudflare Workers vitest pool)
pnpm test:server

# All tests
pnpm test:all
```

Unit tests live next to source files as `*.test.ts`. Server tests use `@cloudflare/vitest-pool-workers` and import from `cloudflare:test`.

## Building

```bash
# Build all packages
pnpm build

# Build a specific package
pnpm --filter=@zooid/sdk build
pnpm --filter=@zooid/web build
pnpm --filter=zooid build       # CLI
```

## Development

```bash
# Run the server locally (requires wrangler)
pnpm -C packages/server dev

# Watch-build the CLI
pnpm -C packages/cli dev
```

## Code style

- **Formatting**: Prettier — run `pnpm format` or `pnpm format:check`
- **Linting**: ESLint — run `pnpm lint`
- **Files & folders**: kebab-case (`well-known.ts`)
- **Functions & variables**: camelCase (`createToken`)
- **Types & interfaces**: PascalCase (`ZooidJWT`)
- **Database / API fields**: snake_case (`channel_id`)
- **Env vars**: UPPER_SNAKE_CASE (`ZOOID_JWT_SECRET`)

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests for any new behavior
4. Run `pnpm test` and `pnpm test:server` to make sure everything passes
5. Run `pnpm format` to format your code
6. Open a pull request against `main`

Keep PRs focused — one feature or fix per PR.

## Architecture notes

- **Auth is stateless** — JWT tokens with three scopes: `admin`, `publish`, `subscribe`
- **Ed25519** for webhook signing — consumers verify with a public key, no shared secrets
- **Cloudflare Workers constraints** — 10ms CPU limit, use `waitUntil()` for fan-out
- **CDN caching** on public channel poll endpoints reduces D1 reads
- **WebSockets via Durable Objects** for real-time push

See `CLAUDE.md` for the full technical reference.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
