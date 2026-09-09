/**
 * TTL-bounded replay defence for webhook delivery ids. GitHub sends no
 * timestamp, so freshness-window rejection (used for Stripe/Slack in
 * `webhook-verify.ts`) is not available — dedupe on delivery id instead.
 * Keys are namespaced by trigger name (e.g. `t1:abc`) so two triggers never
 * collide on the same upstream id.
 */
export class DeliveryCache {
  private readonly ttlMs: number
  private readonly expiryById = new Map<string, number>()

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  get size(): number {
    return this.expiryById.size
  }

  /** Returns true if `id` was already seen (and still within its TTL). */
  seen(id: string): boolean {
    this.evictExpired()
    const now = Date.now()
    const expiry = this.expiryById.get(id)
    if (expiry !== undefined && expiry > now) return true
    this.expiryById.set(id, now + this.ttlMs)
    return false
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [id, expiry] of this.expiryById) {
      if (expiry <= now) this.expiryById.delete(id)
    }
  }
}
