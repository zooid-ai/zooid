import { sign, verify } from 'hono/jwt';
import type { ZooidJWT } from '../types';

export async function createToken(
  claims: Partial<ZooidJWT>,
  secret: string,
  options?: { expiresIn?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    ...claims,
    iat: now,
  };

  if (options?.expiresIn !== undefined) {
    payload.exp = now + options.expiresIn;
  }

  return sign(payload, secret, 'HS256');
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<ZooidJWT> {
  const payload = await verify(token, secret, 'HS256');
  return payload as unknown as ZooidJWT;
}
