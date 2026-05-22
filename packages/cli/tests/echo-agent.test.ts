import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIM = join(HERE, '__fixtures__', 'echo-agent.ts')

interface Frame {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
}

function send(child: ReturnType<typeof spawn>, frame: Frame): void {
  child.stdin!.write(JSON.stringify(frame) + '\n')
}

async function readFrames(child: ReturnType<typeof spawn>, n: number): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const out: Frame[] = []
    let buf = ''
    const onData = (b: Buffer): void => {
      buf += b.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        out.push(JSON.parse(line) as Frame)
        if (out.length >= n) {
          child.stdout!.off('data', onData)
          resolve(out)
          return
        }
      }
    }
    child.stdout!.on('data', onData)
    child.once('error', reject)
    child.once('exit', () => {
      if (out.length < n) reject(new Error(`echo shim exited after ${out.length}/${n} frames`))
    })
  })
}

describe('echo-agent ACP shim', () => {
  it('responds to initialize, newSession, and prompt with an agent_message_chunk', async () => {
    const child = spawn('node', ['--import', 'tsx', SHIM], { stdio: ['pipe', 'pipe', 'inherit'] })

    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    const [initResp] = await readFrames(child, 1)
    expect(initResp).toMatchObject({ id: 1, result: { protocolVersion: expect.any(Number) } })

    send(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/tmp', mcpServers: [] },
    })
    const [newResp] = await readFrames(child, 1)
    expect(newResp).toMatchObject({ id: 2, result: { sessionId: expect.any(String) } })
    const sessionId = (newResp.result as { sessionId: string }).sessionId

    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
    })
    // The shim emits one session/update notification, then the prompt response.
    const frames = await readFrames(child, 2)
    const update = frames.find((f) => f.method === 'session/update')
    expect(update).toBeDefined()
    expect(update!.params).toMatchObject({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: expect.stringContaining('echo: hello') },
      },
    })
    const promptResp = frames.find((f) => f.id === 3)
    expect(promptResp).toMatchObject({ id: 3, result: { stopReason: 'end_turn' } })

    child.kill('SIGTERM')
  }, 15_000)
})
