import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAttachment } from './attachments.js'

describe('writeAttachment', () => {
  it('writes under .zooid/attachments/<event-id>/<filename> and returns both path views', () => {
    const ws = mkdtempSync(join(tmpdir(), 'zooid-att-'))
    try {
      const out = writeAttachment({
        workspaceDir: ws,
        agentWorkspacePath: '/workspace',
        eventId: '$abc123:localhost',
        filename: 'report.pdf',
        data: Buffer.from('hello'),
      })
      expect(out.hostPath).toBe(join(ws, '.zooid', 'attachments', 'abc123localhost', 'report.pdf'))
      expect(out.agentPath).toBe('/workspace/.zooid/attachments/abc123localhost/report.pdf')
      expect(readFileSync(out.hostPath, 'utf8')).toBe('hello')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('sanitizes path-traversal and separator characters in filenames', () => {
    const ws = mkdtempSync(join(tmpdir(), 'zooid-att-'))
    try {
      const out = writeAttachment({
        workspaceDir: ws,
        agentWorkspacePath: '/workspace',
        eventId: '$e1',
        filename: '../../etc/passwd',
        data: Buffer.from('x'),
      })
      expect(out.hostPath.startsWith(join(ws, '.zooid', 'attachments'))).toBe(true)
      expect(out.hostPath).not.toContain('..')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('falls back to a default filename when body is empty', () => {
    const ws = mkdtempSync(join(tmpdir(), 'zooid-att-'))
    try {
      const out = writeAttachment({
        workspaceDir: ws,
        agentWorkspacePath: '/workspace',
        eventId: '$e2',
        filename: '',
        data: Buffer.from('x'),
      })
      expect(out.agentPath).toMatch(/\/file$/)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
