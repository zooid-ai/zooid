import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import * as tar from 'tar'

export function makeBundleTgz(
  files: Record<string, string> = {
    'package/package.json': '{"name":"@zooid/zoon-web"}',
    'package/dist/index.html': '<html>zoon</html>',
    'package/dist/assets/app.js': '// app',
  },
): { tgz: Buffer; integrity: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zooid-tgz-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    const tgz = tar
      .create({ sync: true, gzip: true, cwd: dir, portable: true }, ['package'])
      .read() as Buffer
    const integrity = 'sha512-' + createHash('sha512').update(tgz).digest('base64')
    return { tgz, integrity }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
