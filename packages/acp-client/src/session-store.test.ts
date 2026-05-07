import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonFileSessionStore } from './session-store.js'

describe('JsonFileSessionStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zooid-session-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns undefined for an unseen threadId on a fresh store', async () => {
    const store = new JsonFileSessionStore({ agentId: 'docs', dir })
    await store.load()
    expect(store.get('$thread1')).toBeUndefined()
  })

  it('persists a write and is readable from a new instance', async () => {
    const a = new JsonFileSessionStore({ agentId: 'docs', dir })
    await a.load()
    await a.set('$thread1', 'sess_aaa')

    const b = new JsonFileSessionStore({ agentId: 'docs', dir })
    await b.load()
    expect(b.get('$thread1')).toBe('sess_aaa')
  })

  it('overwrites an existing threadId on set()', async () => {
    const store = new JsonFileSessionStore({ agentId: 'docs', dir })
    await store.load()
    await store.set('$thread1', 'sess_aaa')
    await store.set('$thread1', 'sess_bbb')
    expect(store.get('$thread1')).toBe('sess_bbb')
  })

  it('delete() removes a threadId, persists, survives reload', async () => {
    const a = new JsonFileSessionStore({ agentId: 'docs', dir })
    await a.load()
    await a.set('$thread1', 'sess_aaa')
    await a.delete('$thread1')

    const b = new JsonFileSessionStore({ agentId: 'docs', dir })
    await b.load()
    expect(b.get('$thread1')).toBeUndefined()
  })

  it('creates the dir on first write if it does not yet exist', async () => {
    const nested = join(dir, 'agents', 'docs')
    const store = new JsonFileSessionStore({ agentId: 'docs', dir: nested })
    await store.load()
    await store.set('$t', 'sess_x')
    const raw = await readFile(join(nested, 'sessions.json'), 'utf8')
    expect(JSON.parse(raw).agent_id).toBe('docs')
  })

  it('treats a missing file as empty (no throw)', async () => {
    const store = new JsonFileSessionStore({ agentId: 'docs', dir })
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.get('anything')).toBeUndefined()
  })

  it('treats a corrupted JSON file as empty (logs, no throw)', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'sessions.json'), 'this is not json{', 'utf8')
    const store = new JsonFileSessionStore({ agentId: 'docs', dir })
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.get('anything')).toBeUndefined()
  })

  it('treats a file with mismatched agent_id as empty', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify({
        version: 1,
        agent_id: 'someone-else',
        sessions: [{ thread_id: '$t', session_id: 'sess_x', updated_at: '2026-05-07T00:00:00Z' }],
      }),
      'utf8',
    )
    const store = new JsonFileSessionStore({ agentId: 'docs', dir })
    await store.load()
    expect(store.get('$t')).toBeUndefined()
  })

  it('writes atomically (temp file then rename) and produces valid JSON', async () => {
    const store = new JsonFileSessionStore({ agentId: 'docs', dir })
    await store.load()
    await store.set('$t', 'sess_x')
    const raw = await readFile(join(dir, 'sessions.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; agent_id: string; sessions: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.agent_id).toBe('docs')
    expect(parsed.sessions).toHaveLength(1)
  })

  it('serialises concurrent set() calls (last write wins, file stays valid)', async () => {
    const store = new JsonFileSessionStore({ agentId: 'docs', dir })
    await store.load()
    await Promise.all([
      store.set('$t1', 'sess_1'),
      store.set('$t2', 'sess_2'),
      store.set('$t3', 'sess_3'),
    ])
    const raw = await readFile(join(dir, 'sessions.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(store.get('$t1')).toBe('sess_1')
    expect(store.get('$t2')).toBe('sess_2')
    expect(store.get('$t3')).toBe('sess_3')
  })
})
