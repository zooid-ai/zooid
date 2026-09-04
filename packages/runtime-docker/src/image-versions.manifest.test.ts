import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectPins, type ImageManifest } from './image-versions.js'

const DOCKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker')

function loadManifest(): ImageManifest {
  return JSON.parse(readFileSync(join(DOCKER_DIR, 'versions.json'), 'utf8'))
}

function loadDockerfiles(manifest: ImageManifest): Record<string, string> {
  return Object.fromEntries(
    Object.keys(manifest).map((dir) => [
      dir,
      readFileSync(join(DOCKER_DIR, dir, 'Dockerfile'), 'utf8'),
    ]),
  )
}

describe('docker/versions.json ⇄ Dockerfiles (ZOD074)', () => {
  it('collectPins accepts the committed tree — no drift in either direction', () => {
    const manifest = loadManifest()
    expect(() => collectPins(manifest, loadDockerfiles(manifest))).not.toThrow()
  })

  it('every pin resolves to a non-empty version', () => {
    const manifest = loadManifest()
    for (const pin of collectPins(manifest, loadDockerfiles(manifest))) {
      expect(pin.version, `${pin.imageDir}/${pin.argName}`).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  // Catches the other forgetting: a new agent-* image dir that pins packages
  // but never gets a manifest entry, so the bumper never sees it.
  it('every agent-* image dir with a *_VERSION ARG is in the manifest', () => {
    const manifest = loadManifest()
    const dirs = readdirSync(DOCKER_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('agent-'))
      .map((e) => e.name)
      .filter((d) => existsSync(join(DOCKER_DIR, d, 'Dockerfile')))

    for (const dir of dirs) {
      const text = readFileSync(join(DOCKER_DIR, dir, 'Dockerfile'), 'utf8')
      if (/^ARG\s+\w*_VERSION=/m.test(text)) {
        expect(Object.keys(manifest), `${dir} pins versions but is not in versions.json`)
          .toContain(dir)
      }
    }
  })

  // agent-base installs from apt, not npm — it must stay out (see Non-goals).
  it('does not claim agent-base', () => {
    expect(Object.keys(loadManifest())).not.toContain('agent-base')
  })
})
