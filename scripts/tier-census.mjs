// Which tier each Docker-gated suite runs in (ZOD098 § 7). A suite guarded by
// skipIf(!dockerAvailable()) must be selected by its package's test:infra
// script or listed below, and must never be in a test:socket script.
// tier-census.test.ts runs this in build-test via the root test:socket.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseTierArgs } from './tier-report.mjs'

/** Docker suites deliberately not in a test:infra script yet, each with the issue that brings it in. */
export const NOT_YET_IN_INFRA = {
  'packages/cli/tests/zooid-dev.integration.test.ts': 'zooid-ai/zooid#116',
  'packages/cli/tests/zooid-dev-cycle2.integration.test.ts': 'zooid-ai/zooid#116',
  'packages/transport-matrix/tests/integration.test.ts': 'zooid-ai/zooid#116',
}

const DOCKER_GUARD = /\bskipIf\(\s*!\s*dockerAvailable\(\)/

/** @param {string} source */
export function isDockerGated(source) {
  return DOCKER_GUARD.test(source)
}

/** The test paths a `node ../../scripts/test-tier.mjs …` script selects; [] if the package has no such script. */
export function tierScriptPaths(script) {
  if (!script) return []
  const argv = script.trim().split(/\s+/)
  const at = argv.findIndex((a) => a.endsWith('scripts/test-tier.mjs'))
  if (at === -1) throw new Error(`tier script must run scripts/test-tier.mjs so skips fail it: ${script}`)
  return parseTierArgs(argv.slice(at + 1)).paths
}

export function censusViolations({ dockerSuites, infra, socket, notYet }) {
  const inInfra = new Set(infra)
  const inSocket = new Set(socket)
  const docker = new Set(dockerSuites)
  const violations = []
  for (const f of dockerSuites) {
    if (inSocket.has(f)) {
      violations.push(`${f}: Docker suite in a test:socket script — tier 2 must not need Docker`)
    } else if (inInfra.has(f) && f in notYet) {
      violations.push(`${f}: in test:infra and on NOT_YET_IN_INFRA — remove it from the list`)
    } else if (!inInfra.has(f) && !(f in notYet)) {
      violations.push(`${f}: Docker suite runs nowhere — add it to its package's test:infra, or to NOT_YET_IN_INFRA with an issue`)
    }
  }
  for (const f of Object.keys(notYet)) {
    if (!docker.has(f)) violations.push(`${f}: on NOT_YET_IN_INFRA but not a Docker suite — renamed, moved or deleted?`)
  }
  return violations
}

/** Scans packages/* for Docker-gated suites and for what each package's tier scripts select. Paths are repo-relative. */
export function readCensus(root) {
  const dockerSuites = []
  const infra = []
  const socket = []
  for (const name of readdirSync(join(root, 'packages'))) {
    const dir = join(root, 'packages', name)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    for (const file of testFiles(dir)) {
      if (isDockerGated(readFileSync(file, 'utf8'))) dockerSuites.push(repoPath(root, file))
    }
    const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'))
    infra.push(...selected(root, dir, tierScriptPaths(scripts['test:infra'])))
    socket.push(...selected(root, dir, tierScriptPaths(scripts['test:socket'])))
  }
  return { dockerSuites, infra, socket }
}

function* testFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* testFiles(p)
    else if (entry.name.endsWith('.test.ts')) yield p
  }
}

// A tier path is a file or a directory. A path that doesn't exist is an error
// rather than an empty set, because a renamed suite must not quietly drop out.
function selected(root, pkgDir, paths) {
  return paths.flatMap((p) => {
    const abs = resolve(pkgDir, p)
    if (!existsSync(abs)) throw new Error(`${repoPath(root, pkgDir)}: tier script names a missing path ${p}`)
    return statSync(abs).isDirectory() ? [...testFiles(abs)].map((f) => repoPath(root, f)) : [repoPath(root, abs)]
  })
}

const repoPath = (root, file) => relative(root, file).split(sep).join('/')
