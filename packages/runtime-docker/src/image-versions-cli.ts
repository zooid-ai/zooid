#!/usr/bin/env node
// ZOD074. `pnpm agent-images:check [--write]`
//
// Reads docker/versions.json + the Dockerfiles, asks the npm registry what is
// current, and reports (or rewrites) stale pins. Exits 1 when anything is out
// of date so the workflow can branch on it.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectPins,
  findOutdated,
  applyPin,
  npmLatestUrl,
  type ImageManifest,
} from './image-versions.js'

const DOCKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker')
const dockerfilePath = (dir: string) => join(DOCKER_DIR, dir, 'Dockerfile')

async function fetchLatest(packageName: string): Promise<string | undefined> {
  const res = await fetch(npmLatestUrl(packageName), {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    console.error(`  ! ${packageName}: registry returned ${res.status}`)
    return undefined
  }
  return ((await res.json()) as { version?: string }).version
}

async function main(): Promise<number> {
  const write = process.argv.includes('--write')

  const manifest: ImageManifest = JSON.parse(
    readFileSync(join(DOCKER_DIR, 'versions.json'), 'utf8'),
  )
  const dockerfiles = Object.fromEntries(
    Object.keys(manifest).map((dir) => [dir, readFileSync(dockerfilePath(dir), 'utf8')]),
  )

  // Throws on drift — a bad manifest is a hard stop, not a warning.
  const pins = collectPins(manifest, dockerfiles)

  const names = [...new Set(pins.map((p) => p.packageName))]
  const resolved = await Promise.all(names.map(fetchLatest))
  const latest: Record<string, string> = {}
  names.forEach((n, i) => {
    const v = resolved[i]
    if (v) latest[n] = v
  })

  const outdated = findOutdated(pins, latest)
  if (outdated.length === 0) {
    console.log(`All ${pins.length} agent-image pins are current.`)
    return 0
  }

  for (const p of outdated) {
    console.log(`${p.imageDir}: ${p.packageName} ${p.version} -> ${p.latest}`)
  }

  if (write) {
    // Group by file so an image with two pins is written once.
    const byDir = new Map<string, typeof outdated>()
    for (const p of outdated) {
      byDir.set(p.imageDir, [...(byDir.get(p.imageDir) ?? []), p])
    }
    for (const [dir, ps] of byDir) {
      let text = dockerfiles[dir]
      for (const p of ps) text = applyPin(text, p.argName, p.latest)
      writeFileSync(dockerfilePath(dir), text)
      console.log(`  wrote ${dir}/Dockerfile`)
    }
  }

  return 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(2)
  },
)
