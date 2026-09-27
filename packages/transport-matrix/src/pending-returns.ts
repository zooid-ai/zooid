import type { AgentBinding } from './router.js'

/** A released return: the resolving turn's final prose, bound for the callee's caller. */
export interface ReleasedReturn {
  callee: string
  roomId: string
  threadRoot: string
  targets: AgentBinding[]
  /** Final non-empty prose of the resolving turn; '' when that turn produced none. */
  text: string
}

export interface PendingReturnsOptions {
  graceMs: number
  /** Fallback for a remote callee's hold ([[ZOD092]] §5). Defaults to `graceMs`. */
  remoteGraceMs?: number
  onRelease: (released: ReleasedReturn) => void
}

interface PendingReturn {
  callee: string
  roomId: string
  threadRoot: string
  targets: Map<string, AgentBinding>
  text: string
  /** The callee's current turn @mentioned an agent: a call, not a return. */
  delegated: boolean
  /** Between turns, waiting on its own callee. Never timed. */
  waiting: boolean
  /** Interrupted while running: its next turn end releases regardless. */
  interrupted: boolean
  /** The callee lives on another workstation: its running turn is invisible here ([[ZOD092]] §5). */
  remote: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Ordinary-thread handoff returns ([[ZOD088]]). A callee's return to its
 * caller is held from the call until a callee turn ends having opened no call
 * of its own, then released once with that turn's final prose. A pending
 * return exists exactly while its call is open.
 *
 * The grace timer is a fallback for a turn end this process cannot see: it
 * never arms while the callee has a turn running here, nor while the callee is
 * waiting on its own callee. Every ambiguity resolves toward releasing.
 * Keyed `<calleeMxid>::<threadRoot>`. A remote callee's hold uses the longer
 * remote window, because its running turn can't be seen here — a single
 * `tool_call` may be followed by a long silence while it actually runs
 * ([[ZOD092]] §5).
 */
export class PendingReturns {
  private readonly pending = new Map<string, PendingReturn>()
  private readonly running = new Map<string, number>()

  constructor(private readonly opts: PendingReturnsOptions) {}

  has(callee: string, threadRoot: string): boolean {
    return this.pending.has(key(callee, threadRoot))
  }

  /** An agent→agent call: a fresh pending return, replacing any earlier one. */
  open(
    callee: string,
    threadRoot: string,
    roomId: string,
    caller: AgentBinding,
    o: { remote?: boolean } = {},
  ): void {
    const k = key(callee, threadRoot)
    this.drop(k)
    this.pending.set(k, fresh(callee, threadRoot, roomId, [caller], o.remote === true))
  }

  /** A callee message routed as a return: held, never delivered on its own. */
  hold(
    callee: string,
    threadRoot: string,
    roomId: string,
    targets: AgentBinding[],
    body: string | undefined,
    o: { remote?: boolean } = {},
  ): void {
    const k = key(callee, threadRoot)
    let p = this.pending.get(k)
    if (!p) {
      p = fresh(callee, threadRoot, roomId, targets, o.remote === true)
      this.pending.set(k, p)
    } else if (o.remote === true) {
      p.remote = true
    }
    for (const t of targets) p.targets.set(t.name, t)
    const text = body?.trim()
    if (text) p.text = text
    p.waiting = false
    this.arm(k)
  }

  /** The callee's current turn opened a call; its turn end is not a return. */
  markDelegated(callee: string, threadRoot: string): void {
    const p = this.pending.get(key(callee, threadRoot))
    if (p) p.delegated = true
  }

  /** Sender-attributable liveness (tool calls, plans): re-arms a timed hold. */
  activity(callee: string, threadRoot: string): void {
    const k = key(callee, threadRoot)
    if (this.pending.get(k)?.timer) this.arm(k)
  }

  turnStarted(agent: string, threadRoot: string): void {
    const k = key(agent, threadRoot)
    this.running.set(k, (this.running.get(k) ?? 0) + 1)
    const p = this.pending.get(k)
    if (p) {
      p.waiting = false
      disarm(p)
    }
  }

  /** The in-process turn is over; if its turn.end never echoes, the fallback catches it. */
  turnFinished(agent: string, threadRoot: string): void {
    const k = key(agent, threadRoot)
    const n = (this.running.get(k) ?? 1) - 1
    if (n > 0) this.running.set(k, n)
    else this.running.delete(k)
    this.arm(k)
  }

  /** The callee's `dev.zooid.turn.end`: release, unless the turn delegated. */
  turnEnded(callee: string, threadRoot: string): void {
    const k = key(callee, threadRoot)
    const p = this.pending.get(k)
    if (!p) return
    if (p.delegated && !p.interrupted) {
      p.delegated = false
      p.waiting = true
      p.text = ''
      disarm(p)
      return
    }
    this.release(k)
  }

  /**
   * A thread interrupt. Running callees are marked so their (cancelled) turn
   * end releases; with nothing running there is no turn end coming, so every
   * pending return in the thread releases now. Call before cancelling
   * sessions, or a turn that finishes first makes the thread look idle.
   */
  interrupt(threadRoot: string): void {
    const suffix = `::${threadRoot}`
    const anyRunning = [...this.running.keys()].some((k) => k.endsWith(suffix))
    for (const [k, p] of [...this.pending]) {
      if (p.threadRoot !== threadRoot) continue
      if (!anyRunning) this.release(k)
      else if (this.running.has(k)) p.interrupted = true
    }
  }

  /** `/clear`: a pre-reset return must never wake anyone later. */
  dropThread(threadRoot: string): void {
    for (const [k, p] of [...this.pending]) if (p.threadRoot === threadRoot) this.drop(k)
  }

  private arm(k: string): void {
    const p = this.pending.get(k)
    if (!p) return
    disarm(p)
    if (p.waiting || this.running.has(k)) return
    const ms = p.remote ? (this.opts.remoteGraceMs ?? this.opts.graceMs) : this.opts.graceMs
    p.timer = setTimeout(() => this.release(k), ms)
    p.timer.unref?.()
  }

  private release(k: string): void {
    const p = this.pending.get(k)
    if (!p) return
    this.pending.delete(k)
    disarm(p)
    this.opts.onRelease({
      callee: p.callee,
      roomId: p.roomId,
      threadRoot: p.threadRoot,
      targets: [...p.targets.values()],
      text: p.text,
    })
  }

  private drop(k: string): void {
    const p = this.pending.get(k)
    if (!p) return
    disarm(p)
    this.pending.delete(k)
  }
}

const key = (agent: string, threadRoot: string) => `${agent}::${threadRoot}`

function fresh(
  callee: string,
  threadRoot: string,
  roomId: string,
  targets: AgentBinding[],
  remote: boolean,
): PendingReturn {
  return {
    callee,
    roomId,
    threadRoot,
    targets: new Map(targets.map((t) => [t.name, t])),
    text: '',
    delegated: false,
    waiting: false,
    interrupted: false,
    remote,
  }
}

function disarm(p: PendingReturn): void {
  if (p.timer) clearTimeout(p.timer)
  p.timer = undefined
}
