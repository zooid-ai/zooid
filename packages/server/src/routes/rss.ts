import { Hono } from 'hono';
import { stringify } from 'yaml';
import type { Bindings, Variables, ZooidEvent } from '../types';
import { getChannel } from '../db/queries';
import { pollEvents, cleanupExpiredEvents } from '../db/queries';
import { verifyToken } from '../lib/jwt';
import { buildXml } from '../lib/xml';

type Env = { Bindings: Bindings; Variables: Variables };

export const rss = new Hono<Env>();

rss.get('/channels/:channelId/rss', async (c) => {
  const channelId = c.req.param('channelId');
  const db = c.env.DB;

  const channel = await getChannel(db, channelId);
  if (!channel) {
    return c.json({ error: 'Channel not found' }, 404);
  }

  // Auth: public channels need no auth, private channels use ?token= query param
  if (channel.is_public !== 1) {
    const tokenStr = c.req.query('token');
    if (!tokenStr) {
      return c.json(
        { error: 'Subscribe token required for private channel' },
        401,
      );
    }

    try {
      const payload = await verifyToken(tokenStr, c.env.ZOOID_JWT_SECRET);
      if (payload.scope !== 'admin' && payload.scope !== 'subscribe') {
        return c.json({ error: 'Insufficient permissions' }, 403);
      }
      if (payload.scope === 'subscribe' && payload.channel !== channelId) {
        return c.json({ error: 'Token not valid for this channel' }, 403);
      }
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  }

  await cleanupExpiredEvents(db, channelId);

  const result = await pollEvents(db, channelId, { limit: 50 });
  const format = c.req.query('format') || 'yaml';

  const items = result.events.map((event) => formatItem(event, format));

  const xml = buildXml({
    rss: {
      '@_version': '2.0',
      channel: {
        title: channel.name,
        description: channel.description || '',
        ...(items.length > 0 ? { item: items } : {}),
      },
    },
  });

  return c.body(xml, 200, {
    'Content-Type': 'application/rss+xml',
  });
});

function formatItem(
  event: ZooidEvent,
  format: string,
): Record<string, unknown> {
  const type = event.type || 'event';
  const publisher = event.publisher_id || 'unknown';

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.data);
  } catch {
    data = {};
  }

  const description =
    format === 'json' ? JSON.stringify(data, null, 2) : stringify(data).trim();

  return {
    title: `[${type}] ${publisher}`,
    description: `<![CDATA[${description}]]>`,
    pubDate: new Date(event.created_at).toUTCString(),
    guid: event.id,
  };
}
