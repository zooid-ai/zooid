import { createMiddleware } from 'hono/factory';
import type { Bindings, Variables, ZooidJWT } from '../types';
import { verifyToken } from '../lib/jwt';

type Env = { Bindings: Bindings; Variables: Variables };

export function requireAuth() {
  return createMiddleware<Env>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const payload = await verifyToken(token, c.env.ZOOID_JWT_SECRET);
      c.set('jwtPayload', payload);
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    await next();
  });
}

export function requireScope(
  scope: string,
  options?: { channelParam?: string },
) {
  return createMiddleware<Env>(async (c, next) => {
    const payload = c.get('jwtPayload') as ZooidJWT;

    // Admin can do anything
    if (payload.scope === 'admin') {
      await next();
      return;
    }

    // Check scope matches
    if (payload.scope !== scope) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }

    // Check channel matches if channel-scoped
    if (options?.channelParam) {
      const channelId = c.req.param(options.channelParam);
      if (payload.channel !== channelId) {
        return c.json({ error: 'Token not valid for this channel' }, 403);
      }
    }

    await next();
  });
}

export function requireSubscribeIfPrivate(channelParam: string) {
  return createMiddleware<Env>(async (c, next) => {
    const channelId = c.req.param(channelParam);
    const db = c.env.DB;

    const channel = await db
      .prepare('SELECT is_public FROM channels WHERE id = ?')
      .bind(channelId)
      .first<{ is_public: number }>();

    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    if (channel.is_public === 1) {
      c.set('channelIsPublic', true);
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');
    const queryToken = c.req.query('token');
    const rawToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (queryToken ?? null);

    if (!rawToken) {
      return c.json(
        { error: 'Subscribe token required for private channel' },
        401,
      );
    }

    const token = rawToken;
    try {
      const payload = await verifyToken(token, c.env.ZOOID_JWT_SECRET);
      if (payload.scope !== 'admin' && payload.scope !== 'subscribe') {
        return c.json({ error: 'Insufficient permissions' }, 403);
      }
      if (payload.scope === 'subscribe' && payload.channel !== channelId) {
        return c.json({ error: 'Token not valid for this channel' }, 403);
      }
      c.set('jwtPayload', payload);
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    await next();
  });
}
