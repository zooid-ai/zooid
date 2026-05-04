import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

export interface AgentProcessOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export class AgentProcess extends EventEmitter {
  private child: ChildProcess | null = null

  constructor(private readonly options: AgentProcessOptions) {
    super()
  }

  start(): void {
    if (this.child) return
    const env = { ...process.env, ...(this.options.env ?? {}) }
    this.child = spawn(this.options.command, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.options.cwd,
    })
    this.child.on('exit', (code, signal) => this.emit('exit', code, signal))
    this.child.on('error', (err) => this.emit('error', err))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child?.kill(signal)
  }

  get stdout(): Readable {
    if (!this.child?.stdout) throw new Error('agent process not started')
    return this.child.stdout
  }

  get stdin(): Writable {
    if (!this.child?.stdin) throw new Error('agent process not started')
    return this.child.stdin
  }

  get stderr(): Readable {
    if (!this.child?.stderr) throw new Error('agent process not started')
    return this.child.stderr
  }
}
