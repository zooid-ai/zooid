import { mkdirSync, renameSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as tar from 'tar'

const PKG = '@zooid/zoon-web'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

export interface FetchWebBundleOptions {
  version: string
  cacheDir: string
  registryUrl?: string
  fetch?: typeof globalThis.fetch
}

/**
 * Ensure <cacheDir>/<version> holds the extracted dist/ of @zooid/zoon-web.
 * Atomic: extracts into a temp dir and renames, so a crash never leaves a
 * half-populated version dir. A populated version dir (index.html present)
 * is the completion marker.
 */
export async function fetchWebBundle(opts: FetchWebBundleOptions): Promise<string> {
  const target = join(opts.cacheDir, opts.version)
  if (existsSync(join(target, 'index.html'))) return target
  if (existsSync(target)) rmSync(target, { recursive: true, force: true }) // crashed extract

  const f = opts.fetch ?? globalThis.fetch
  const registry = (opts.registryUrl ?? DEFAULT_REGISTRY).replace(/\/$/, '')
  let tgz: Buffer
  try {
    const metaRes = await f(`${registry}/${PKG}`)
    if (!metaRes.ok) throw new Error(`registry metadata: HTTP ${metaRes.status}`)
    const meta = (await metaRes.json()) as {
      versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>
    }
    const dist = meta.versions?.[opts.version]?.dist
    if (!dist?.tarball || !dist.integrity) {
      throw new Error(`${PKG}@${opts.version} not found on the registry`)
    }
    const tgzRes = await f(dist.tarball)
    if (!tgzRes.ok) throw new Error(`tarball: HTTP ${tgzRes.status}`)
    tgz = Buffer.from(await tgzRes.arrayBuffer())
    const sha = 'sha512-' + createHash('sha512').update(tgz).digest('base64')
    if (sha !== dist.integrity) {
      throw new Error(`integrity mismatch for ${PKG}@${opts.version}: got ${sha}`)
    }
  } catch (err) {
    throw new Error(
      `Failed to fetch ${PKG}@${opts.version} from ${registry}.\n` +
        `  Cache: ${opts.cacheDir}\n` +
        `  Offline? Point ZOOID_DEV_WEB_ROOT_OVERRIDE at a built dist as a manual escape hatch.\n` +
        `  Cause: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const tmp = join(opts.cacheDir, `.tmp-${randomUUID().slice(0, 8)}`)
  mkdirSync(tmp, { recursive: true })
  const tgzPath = join(tmp, '.bundle.tgz')
  try {
    writeFileSync(tgzPath, tgz)
    // node-tar handles gunzip, pax headers, and long names itself, and its
    // defaults refuse absolute paths and `..` traversal.
    await tar.extract({
      file: tgzPath,
      cwd: tmp,
      strip: 2, // package/dist/<file> → <file>
      filter: (p) => p === 'package/dist' || p.startsWith('package/dist/'),
    })
    rmSync(tgzPath)
    if (!existsSync(join(tmp, 'index.html'))) {
      throw new Error(`${PKG}@${opts.version} tarball has no dist/index.html`)
    }
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }

  for (const entry of readdirSync(opts.cacheDir)) {
    if (entry !== opts.version) {
      rmSync(join(opts.cacheDir, entry), { recursive: true, force: true })
    }
  }
  return target
}
