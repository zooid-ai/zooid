import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { posix } from 'node:path'

function sanitize(s: string, fallback: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '')
  return cleaned || fallback
}

export interface WriteAttachmentInput {
  workspaceDir: string
  agentWorkspacePath: string
  eventId: string
  filename: string
  data: Uint8Array
}

export function writeAttachment(input: WriteAttachmentInput): {
  hostPath: string
  agentPath: string
} {
  const dir = sanitize(input.eventId, 'event')
  const name = sanitize(input.filename, 'file')
  const hostDir = join(input.workspaceDir, '.zooid', 'attachments', dir)
  mkdirSync(hostDir, { recursive: true })
  const hostPath = join(hostDir, name)
  writeFileSync(hostPath, input.data)
  const agentPath = posix.join(input.agentWorkspacePath, '.zooid', 'attachments', dir, name)
  return { hostPath, agentPath }
}
