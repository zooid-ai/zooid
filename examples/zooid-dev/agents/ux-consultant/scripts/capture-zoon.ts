// Capture Zoon's UI to disk so the ux-consultant agent can read it.
//
//   pnpm capture                  # uses defaults from scenarios.json
//   ZOON_URL=http://...  pnpm capture
//   SCENARIOS=alt.json pnpm capture
//
// Output: screenshots/<ISO-timestamp>/<scenario>/{desktop,mobile}.png
// Plus screenshots/latest -> symlink to the most recent run.

import { chromium, type Browser, type Page } from 'playwright'
import { readFile, mkdir, symlink, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const agentRoot = resolve(here, '..')
const ZOON_URL = (process.env.ZOON_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const HS_URL = (process.env.MATRIX_HOMESERVER ?? 'http://localhost:8448').replace(/\/$/, '')
const ZOON_USER = process.env.ZOON_USER ?? 'admin'
const ZOON_PASS = process.env.ZOON_PASS ?? 'admin'
const SCENARIOS_FILE = resolve(here, process.env.SCENARIOS ?? 'scenarios.json')
const OUT_BASE = resolve(agentRoot, 'screenshots')

interface Scenario {
  name: string
  /** Direct path. One of `path` or `roomAlias` is required. */
  path?: string
  /**
   * Matrix room alias (e.g. "#welcome:localhost"). Resolved to an internal
   * room id at runtime and turned into `/room/<id>`. Removes the need to
   * hardcode `!abc:localhost` ids that change between `zooid dev` resets.
   */
  roomAlias?: string
  /** ms to wait after networkidle before snapshot. Default 200. */
  settle_ms?: number
}

interface Viewport {
  width: number
  height: number
}

interface Config {
  viewports: Record<string, Viewport>
  scenarios: Scenario[]
}

async function main(): Promise<void> {
  const cfg = JSON.parse(await readFile(SCENARIOS_FILE, 'utf8')) as Config
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = join(OUT_BASE, stamp)
  await mkdir(runDir, { recursive: true })

  console.log(`[capture] target=${ZOON_URL} scenarios=${cfg.scenarios.length} out=${runDir}`)

  // Get a Matrix access token for ZOON_USER and seed it into Zoon's
  // `localStorage["zoon:session"]` so every captured route renders the
  // logged-in app instead of the sign-in form. Skip silently if login
  // fails — the user can still get sign-in-page screenshots.
  const session = await tryLogin().catch((err) => {
    console.warn(`[capture] login as ${ZOON_USER} failed (${(err as Error).message}); ` +
      `screenshots will show the unauthenticated app`)
    return undefined
  })
  if (session) {
    console.log(`[capture] authed as ${session.userId} device=${session.deviceId}`)
  }

  // Resolve `roomAlias` → `/room/<internal-id>` once per scenario. Skip
  // scenarios whose alias doesn't resolve so a missing room doesn't take
  // out the whole run.
  const resolved: Array<Scenario & { path: string }> = []
  for (const s of cfg.scenarios) {
    if (s.path) {
      resolved.push({ ...s, path: s.path })
      continue
    }
    if (s.roomAlias) {
      try {
        const id = await resolveAlias(s.roomAlias, session?.accessToken)
        // Zoon's router treats `:roomId` as a single literal path segment —
        // don't URL-encode, the `!` and `:` are part of the matched value.
        resolved.push({ ...s, path: `/room/${id}` })
      } catch (err) {
        console.warn(`  ! ${s.name}: ${s.roomAlias} → ${(err as Error).message} (skipping)`)
      }
      continue
    }
    console.warn(`  ! ${s.name}: neither path nor roomAlias set (skipping)`)
  }

  const browser = await chromium.launch()
  try {
    for (const scenario of resolved) {
      const scenarioDir = join(runDir, slug(scenario.name))
      await mkdir(scenarioDir, { recursive: true })
      for (const [vpName, vp] of Object.entries(cfg.viewports)) {
        await snapshot(browser, scenario, vp, join(scenarioDir, `${vpName}.png`), session)
        console.log(`  ✓ ${scenario.name} @ ${vpName}`)
      }
    }
  } finally {
    await browser.close()
  }

  // Refresh the convenience `latest` symlink so the agent always knows where
  // to look without sorting timestamps.
  const latest = join(OUT_BASE, 'latest')
  if (existsSync(latest)) await rm(latest, { force: true })
  await symlink(stamp, latest, 'dir')
  console.log(`[capture] done → ${runDir}`)
  console.log(`[capture] latest → ${latest}`)
}

interface ZoonSession {
  homeserverUrl: string
  accessToken: string
  userId: string
  deviceId: string
}

async function tryLogin(): Promise<ZoonSession> {
  const r = await fetch(`${HS_URL}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: ZOON_USER },
      password: ZOON_PASS,
      initial_device_display_name: 'ux-consultant capture',
    }),
  })
  if (!r.ok) throw new Error(`POST /login → ${r.status}`)
  const body = (await r.json()) as {
    user_id: string
    access_token: string
    device_id: string
  }
  return {
    homeserverUrl: HS_URL,
    accessToken: body.access_token,
    userId: body.user_id,
    deviceId: body.device_id,
  }
}

async function resolveAlias(alias: string, accessToken: string | undefined): Promise<string> {
  const headers: Record<string, string> = {}
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const r = await fetch(
    `${HS_URL}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    { headers },
  )
  if (!r.ok) throw new Error(`GET /directory/room/${alias} → ${r.status}`)
  return ((await r.json()) as { room_id: string }).room_id
}

async function snapshot(
  browser: Browser,
  scenario: Scenario & { path: string },
  viewport: Viewport,
  out: string,
  session: ZoonSession | undefined,
): Promise<void> {
  const context = await browser.newContext({ viewport })
  // Seed localStorage["zoon:session"] for the Zoon origin before any nav.
  // Playwright's addInitScript runs in every new document on this context,
  // so it lands before Zoon's bootstrap reads storage.
  if (session) {
    await context.addInitScript((s) => {
      window.localStorage.setItem('zoon:session', JSON.stringify(s))
    }, session)
  }
  const page: Page = await context.newPage()
  try {
    const url = ZOON_URL + scenario.path
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {
      // Networkidle sometimes never settles on apps with long-polling. Fall
      // back to DOM-ready and a fixed wait — better than aborting.
      return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    })
    await page.waitForTimeout(scenario.settle_ms ?? 200)
    await page.screenshot({ path: out, fullPage: true })
  } finally {
    await context.close()
  }
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

await main()
