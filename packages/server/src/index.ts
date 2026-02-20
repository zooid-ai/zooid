import { Hono } from 'hono';
import { fromHono } from 'chanfana';
import type { Bindings, Variables } from './types';
import { wellKnown } from './routes/well-known';
import {
  requireAuth,
  requireScope,
  requireSubscribeIfPrivate,
} from './middleware/auth';
import { ListChannels, CreateChannel, AddPublisher } from './routes/channels';
import { PublishEvents, PollEvents } from './routes/events';
import { RegisterWebhook, DeleteWebhook } from './routes/webhooks';
import { GetServerMeta, UpdateServerMeta } from './routes/server-meta';
import { DirectoryClaim } from './routes/directory';
import { ws } from './routes/ws';
import { rss } from './routes/rss';
import { feed } from './routes/feed';
import { opml } from './routes/opml';

type Env = { Bindings: Bindings; Variables: Variables };

const app = new Hono<Env>();

// Well-known stays at root
app.route('', wellKnown);

// All API routes under /api
const api = new Hono<Env>();
const openapi = fromHono(api, {
  docs_url: '/docs',
  redoc_url: null,
  openapi_url: '/openapi.json',
  schema: {
    info: {
      title: 'Zooid',
      version: '0.1.0',
      description: 'Pub/sub for AI agents',
    },
    security: [{ bearerAuth: [] }],
  },
});
openapi.registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// Server meta routes
openapi.get('/server', GetServerMeta);
// @ts-expect-error chanfana types don't include middleware overloads
openapi.put('/server', requireAuth(), requireScope('admin'), UpdateServerMeta);

// Channel routes
openapi.get('/channels', ListChannels);
// @ts-expect-error chanfana types don't include middleware overloads
openapi.post('/channels', requireAuth(), requireScope('admin'), CreateChannel);
// prettier-ignore
// @ts-expect-error chanfana types don't include middleware overloads
openapi.post('/channels/:channelId/publishers', requireAuth(), requireScope('admin'), AddPublisher);

// Event routes
// prettier-ignore
// @ts-expect-error chanfana types don't include middleware overloads
openapi.post('/channels/:channelId/events', requireAuth(), requireScope('publish', { channelParam: 'channelId' }), PublishEvents);
// prettier-ignore
// @ts-expect-error chanfana types don't include middleware overloads
openapi.get('/channels/:channelId/events', requireSubscribeIfPrivate('channelId'), PollEvents);

// Directory claim route
// prettier-ignore
// @ts-expect-error chanfana types don't include middleware overloads
openapi.post('/directory/claim', requireAuth(), requireScope('admin'), DirectoryClaim);

// Webhook routes
// prettier-ignore
// @ts-expect-error chanfana types don't include middleware overloads
openapi.post('/channels/:channelId/webhooks', requireSubscribeIfPrivate('channelId'), RegisterWebhook);
// prettier-ignore
// @ts-expect-error chanfana types don't include middleware overloads
openapi.delete('/channels/:channelId/webhooks/:webhookId', requireAuth(), requireScope('admin'), DeleteWebhook);

// Plain Hono routes (streaming/XML — not suited for OpenAPI)
api.route('', ws);
api.route('', rss);
api.route('', feed);
api.route('', opml);

api.get('/', (c) => c.json({ ok: true }));
app.route('/api/v1', api);

export { ChannelDO } from './do/channel';
export default app;
