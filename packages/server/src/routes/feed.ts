import { Hono } from 'hono';
import { stringify } from 'yaml';
import type { Bindings, Variables, ZooidEvent } from '../types';
import { getChannel } from '../db/queries';
import { pollEvents, cleanupExpiredEvents } from '../db/queries';
import { verifyToken } from '../lib/jwt';

type Env = { Bindings: Bindings; Variables: Variables };

export const feed = new Hono<Env>();

feed.get('/channels/:channelId/feed.json', async (c) => {
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

  const items = result.events.map((event) =>
    formatItem(event, channelId, format),
  );

  const jsonFeed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: channel.name,
    description: channel.description || '',
    items,
  };

  return c.json(jsonFeed, 200, {
    'Content-Type': 'application/feed+json',
  });
});

function formatItem(
  event: ZooidEvent,
  channelId: string,
  format: string,
): Record<string, unknown> {
  const type = event.type || null;
  const publisher = event.publisher_id || 'unknown';

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(event.data);
  } catch {
    data = {};
  }

  const contentText =
    format === 'json' ? JSON.stringify(data, null, 2) : stringify(data).trim();

  const titleLabel = type || 'event';

  const item: Record<string, unknown> = {
    id: event.id,
    title: `[${titleLabel}] ${publisher}`,
    content_text: contentText,
    date_published: new Date(event.created_at).toISOString(),
    _zooid: {
      channel_id: channelId,
      publisher_id: event.publisher_id || null,
      type: type,
      data,
    },
  };

  if (type) {
    item.tags = [type];
  }

  return item;
}
