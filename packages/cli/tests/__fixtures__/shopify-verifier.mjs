import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * A realistic `provider: custom` verifier, in the shape an operator would
 * write: base64 HMAC-SHA256 of the raw body in a service-specific header,
 * plus that service's delivery id handed back for replay dedupe.
 */
export default function verify({ rawBody, headers, secret }) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64')
  const got = Buffer.from(headers['x-shopify-hmac-sha256'] ?? '', 'utf8')
  const want = Buffer.from(expected, 'utf8')
  const ok = got.length === want.length && timingSafeEqual(got, want)
  return { ok, deliveryId: headers['x-shopify-delivery'] }
}
