// A leading-edge throttle. Calls within `ms` of the last fired call are
// dropped on the floor — no trailing edge, no queuing.
//
// Used by the dashboard's resize handler and the search-as-you-type
// debouncer's outer wrapper. The contract callers rely on:
//
//   1. The first call in any quiet period fires immediately.
//   2. Calls during the cooldown are coalesced; only the *last* arguments
//      seen during the cooldown should fire on the trailing edge, exactly
//      once, at `lastFire + ms`.
//   3. After the trailing call fires, a fresh quiet period begins.
//
// (See README "Throttle contract" — invariant 2 is the one the existing
// tests don't exercise.)

export type AnyFn = (...args: unknown[]) => void

export function throttle<T extends AnyFn>(fn: T, ms: number): T {
  let lastFire = 0

  return function throttled(...args: unknown[]): void {
    const now = Date.now()
    if (now - lastFire >= ms) {
      lastFire = now
      fn(...args)
    }
  } as T
}
