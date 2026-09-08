import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPiExtension } from './pi-extension-install.js'

const dirs: string[] = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'zooid-pi-')); dirs.push(dir); return dir }
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('installPiExtension', () => {
  it('only installs into an existing Pi home and preserves other extensions', () => {
    const home = scratch(); const source = join(scratch(), 'bundle.js')
    writeFileSync(source, '// bundle')
    expect(installPiExtension({ daemonHome: home, bundlePath: source })).toMatchObject({ status: 'skipped' })
    expect(existsSync(join(home, '.pi'))).toBe(false)
    const extensions = join(home, '.pi', 'agent', 'extensions')
    mkdirSync(extensions, { recursive: true }); writeFileSync(join(extensions, 'user.js'), '// user')
    expect(installPiExtension({ daemonHome: home, bundlePath: source })).toMatchObject({ status: 'installed' })
    expect(readFileSync(join(extensions, 'zooid-tasks.js'), 'utf8')).toBe('// bundle')
    expect(readFileSync(join(extensions, 'user.js'), 'utf8')).toBe('// user')
    expect(installPiExtension({ daemonHome: home, bundlePath: source })).toMatchObject({ status: 'unchanged' })
  })
})
