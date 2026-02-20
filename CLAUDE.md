# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zooid is an open-source pub/sub server for AI agents. Agents publish signals to named channels, other agents subscribe via webhook, WebSocket, polling, or RSS. Deploys to Cloudflare Workers with `npx zooid deploy`. The full product and technical spec is in `.specs/zooid-spec.md`.

## Status

Pre-MVP. The spec and README exist but no source code has been written yet. Package manager is **pnpm** (v10.7.0).

## Architecture

Monorepo with packages under `packages/`:

- **`packages/server/`** — Cloudflare Worker (Hono + D1/SQLite). Routes: channels CRUD, event publish/poll, webhook registration, RSS feed, web dashboard, `/.well-known/zooid.json`. Public channel polling is CDN-cached at the edge.
- **`packages/cli/`** — `npx zooid` CLI (Node.js). Commands: deploy, channel, publish, subscribe, config. Stores config at `~/.zooid/config.json`
- **`packages/web/`** — Single-page dashboard inlined into the Worker as a self-contained HTML string (no separate hosting)
- **`packages/skills/`** — Framework integrations (OpenClaw skill, MCP server) — V2 scope

Other top-level directories: `tests/`, `docs/`, `scripts/`.

## Testing

- **Unit tests**: colocated next to source files as `*.test.ts` (e.g. `packages/server/src/routes/channels.test.ts`)
- **Integration/e2e tests**: top-level `tests/` directory for cross-package tests (e.g. `tests/integration/publish-subscribe.test.ts`)
- Test runner: **Vitest**

## Tech Stack

| Component        | Technology                                                    |
| ---------------- | ------------------------------------------------------------- |
| Server framework | Hono                                                          |
| Database         | Cloudflare D1 (SQLite)                                        |
| Runtime          | Cloudflare Workers                                            |
| Auth             | JWT (HS256), stateless — no token table                       |
| Webhook signing  | Ed25519 (asymmetric, public key at `/.well-known/zooid.json`) |
| Event IDs        | ULID (time-ordered, sortable)                                 |
| CLI              | Node.js via npx                                               |

## Key Design Decisions

- **Auth is stateless**: JWT tokens signed with `ZOOID_JWT_SECRET` env var. Three scopes: `admin`, `publish` (channel-scoped), `subscribe` (channel-scoped).
- **Ed25519 over HMAC** for webhook signing: asymmetric means consumers verify with a public key, no shared secrets needed. Signature format: `<timestamp>.<raw_json_body>`.
- **Event payload max 64KB**. Events retained 7 days with lazy cleanup on read (no cron on Workers free tier).
- **Channel IDs**: URL-safe slugs — lowercase alphanumeric + hyphens, 3-64 chars.
- **Webhook delivery is fire-and-forget** in V1 (no retries). Use `waitUntil()` for fan-out to stay within 10ms CPU limit.
- **CDN caching for public channels**: Poll responses include `Cache-Control: public, s-maxage=N` so Cloudflare's CDN serves cached responses at the edge. Requires a custom domain (not `*.workers.dev`). Absorbs DDoS and poll abuse without Worker invocations.
- **WebSockets via Durable Objects** for real-time push. Polling + CDN cache for infrequently updated public channels. No SSE.

## Workers Constraints

- 10ms CPU time limit (free tier) — D1 queries are I/O and don't count. Use `waitUntil()` for webhook fan-out.
- D1: 5M reads/day, 100k writes/day on free tier. CDN caching on public channels dramatically reduces D1 reads.
- Durable Objects (SQLite backend) available on free tier — 100k requests/day, 13,000 GB-s/day duration.
- Ed25519 is native via `crypto.subtle.sign()`/`crypto.subtle.verify()`.

## Naming Conventions

| Context               | Convention          | Example                        |
| --------------------- | ------------------- | ------------------------------ |
| Files & folders       | kebab-case          | `well-known.ts`, `auth.ts`     |
| Functions & variables | camelCase           | `createToken`, `channelId`     |
| Types & interfaces    | PascalCase          | `ZooidJWT`, `ChannelListItem`  |
| Database fields       | snake_case          | `channel_id`, `created_at`     |
| API response fields   | snake_case          | `publish_token`, `event_count` |
| Environment variables | UPPER_SNAKE_CASE    | `ZOOID_JWT_SECRET`             |
| Channel IDs           | lowercase + hyphens | `polymarket-signals`           |
