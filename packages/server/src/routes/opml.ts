import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { listChannels } from '../db/queries';
import { buildXml } from '../lib/xml';

type Env = { Bindings: Bindings; Variables: Variables };

export const opml = new Hono<Env>();

opml.get('/opml', async (c) => {
  const db = c.env.DB;
  const channels = await listChannels(db);
  const url = new URL(c.req.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  const outlines = channels
    .filter((ch) => ch.is_public)
    .map((ch) => ({
      '@_text': ch.name,
      '@_type': 'rss',
      '@_xmlUrl': `${baseUrl}/api/v1/channels/${ch.id}/rss`,
      '@_htmlUrl': `${baseUrl}/${ch.id}`,
      ...(ch.description ? { '@_description': ch.description } : {}),
    }));

  const xml = buildXml({
    opml: {
      '@_version': '2.0',
      head: {
        title: `Zooid Channels — ${url.host}`,
      },
      body: {
        outline: outlines,
      },
    },
  });

  return c.body(xml, 200, {
    'Content-Type': 'text/x-opml',
  });
});
