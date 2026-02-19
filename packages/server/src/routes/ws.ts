import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { requireSubscribeIfPrivate } from '../middleware/auth';

type Env = { Bindings: Bindings; Variables: Variables };

export const ws = new Hono<Env>();

ws.get(
  '/channels/:channelId/ws',
  requireSubscribeIfPrivate('channelId'),
  async (c) => {
    const upgradeHeader = c.req.header('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }

    const channelId = c.req.param('channelId');
    const id = c.env.CHANNEL_DO.idFromName(channelId);
    const stub = c.env.CHANNEL_DO.get(id);

    // Forward the request, preserving ?types= query param for type filtering
    return stub.fetch(c.req.raw);
  },
);
