import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { getServerMeta } from '../db/queries';

const wellKnown = new Hono<{ Bindings: Bindings; Variables: Variables }>();

wellKnown.get('/.well-known/zooid.json', async (c) => {
  const pollInterval = parseInt(c.env.ZOOID_POLL_INTERVAL || '30', 10);
  const meta = await getServerMeta(c.env.DB);

  return c.json({
    version: '0.1',
    public_key: c.env.ZOOID_PUBLIC_KEY || '',
    public_key_format: 'spki',
    algorithm: 'Ed25519',
    server_id: c.env.ZOOID_SERVER_ID || 'zooid-local',
    server_name: meta?.name || c.env.ZOOID_SERVER_NAME || 'Zooid',
    server_description: meta?.description || c.env.ZOOID_SERVER_DESC || null,
    poll_interval: pollInterval,
    delivery: ['poll', 'webhook', 'websocket', 'rss'],
  });
});

export { wellKnown };
