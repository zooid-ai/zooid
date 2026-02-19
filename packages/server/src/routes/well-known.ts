import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';

const wellKnown = new Hono<{ Bindings: Bindings; Variables: Variables }>();

wellKnown.get('/.well-known/zooid.json', (c) => {
  const pollInterval = parseInt(c.env.ZOOID_POLL_INTERVAL || '30', 10);

  return c.json({
    version: '0.1',
    public_key: c.env.ZOOID_PUBLIC_KEY || '',
    public_key_format: 'spki',
    algorithm: 'Ed25519',
    server_id: c.env.ZOOID_SERVER_ID || 'zooid-local',
    poll_interval: pollInterval,
    delivery: ['poll', 'webhook', 'websocket', 'rss'],
  });
});

export { wellKnown };
