import type { SessionEvent } from '@zooid/budd-core'

export function serializeEvent(event: SessionEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

// Test-only: parse an SSE body back into events. Used in integration tests.
export function parseEventStream(text: string): SessionEvent[] {
  const frames = text.split('\n\n').filter((f) => f.startsWith('data: '))
  return frames.map((f) => JSON.parse(f.slice('data: '.length)) as SessionEvent)
}
