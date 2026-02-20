import { OpenAPIRoute } from 'chanfana';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../types';
import {
  getChannel,
  createEvent,
  createEvents,
  pollEvents,
  cleanupExpiredEvents,
  getWebhooksForChannel,
} from '../db/queries';
import { importPrivateKey, signPayload } from '../lib/signing';
import { validateEvent } from '../lib/schema-validator';

type Env = { Bindings: Bindings; Variables: Variables };

export class PublishEvents extends OpenAPIRoute {
  schema = {
    summary: 'Publish event(s) to a channel',
    tags: ['Events'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        channelId: z.string(),
      }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              type: z.string().optional(),
              data: z.unknown().optional(),
              events: z
                .array(
                  z.object({
                    type: z.string().optional(),
                    data: z.unknown(),
                  }),
                )
                .optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Event(s) published',
        content: {
          'application/json': {
            schema: z.union([
              z.object({
                id: z.string(),
                channel_id: z.string(),
                type: z.string().nullable(),
                data: z.string(),
                publisher_id: z.string().nullable(),
                created_at: z.string(),
              }),
              z.object({
                events: z.array(
                  z.object({
                    id: z.string(),
                    channel_id: z.string(),
                    type: z.string().nullable(),
                    data: z.string(),
                    publisher_id: z.string().nullable(),
                    created_at: z.string(),
                  }),
                ),
              }),
            ]),
          },
        },
      },
      400: {
        description: 'Validation error',
        content: {
          'application/json': {
            schema: z.object({ error: z.string() }),
          },
        },
      },
      401: {
        description: 'Missing or invalid authentication',
        content: {
          'application/json': {
            schema: z.object({ error: z.string() }),
          },
        },
      },
      403: {
        description: 'Insufficient permissions',
        content: {
          'application/json': {
            schema: z.object({ error: z.string() }),
          },
        },
      },
      404: {
        description: 'Channel not found',
        content: {
          'application/json': {
            schema: z.object({ error: z.string() }),
          },
        },
      },
    },
  };

  async handle(c: Context<Env>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { channelId } = data.params;
    const db = c.env.DB;

    const channel = await getChannel(db, channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const body = data.body;
    const jwt = c.get('jwtPayload');
    const publisherId = jwt.sub ?? null;

    const strictSchema =
      channel.strict && channel.schema
        ? (JSON.parse(channel.schema) as Record<
            string,
            {
              required?: string[];
              properties?: Record<string, unknown>;
            }
          >)
        : null;

    // Batch publish
    if ('events' in body && Array.isArray(body.events)) {
      for (const evt of body.events) {
        if (evt.data === undefined) {
          return c.json({ error: 'Each event must include a data field' }, 400);
        }
      }

      if (strictSchema) {
        for (const evt of body.events) {
          const result = validateEvent(strictSchema, evt.type, evt.data);
          if (!result.valid) {
            return c.json({ error: result.error }, 400);
          }
        }
      }

      const created = await createEvents(
        db,
        channelId,
        publisherId,
        body.events,
      );

      const fanOut = async () => {
        try {
          const doId = c.env.CHANNEL_DO.idFromName(channelId);
          const stub = c.env.CHANNEL_DO.get(doId);
          for (const event of created) {
            await stub.broadcast(event as unknown as Record<string, unknown>);
          }
        } catch {
          // CHANNEL_DO binding may not exist in tests
        }
        for (const event of created) {
          await deliverToWebhooks(c.env, channelId, event);
        }
      };
      try {
        c.executionCtx.waitUntil(fanOut());
      } catch {
        await fanOut();
      }

      return c.json({ events: created }, 201);
    }

    // Single publish
    if (!('data' in body) || body.data === undefined) {
      return c.json({ error: 'Event must include a data field' }, 400);
    }

    if (strictSchema) {
      const result = validateEvent(strictSchema, body.type, body.data);
      if (!result.valid) {
        return c.json({ error: result.error }, 400);
      }
    }

    const event = await createEvent(db, {
      channelId,
      publisherId,
      type: body.type ?? null,
      data: body.data,
    });

    const afterPublish = async () => {
      try {
        const doId = c.env.CHANNEL_DO.idFromName(channelId);
        const stub = c.env.CHANNEL_DO.get(doId);
        await stub.broadcast(event as unknown as Record<string, unknown>);
      } catch {
        // CHANNEL_DO binding may not exist in tests
      }
      await deliverToWebhooks(c.env, channelId, event);
    };
    try {
      c.executionCtx.waitUntil(afterPublish());
    } catch {
      // No execution context in tests
    }

    return c.json(event, 201);
  }
}

export class PollEvents extends OpenAPIRoute {
  schema = {
    summary: 'Poll events from a channel',
    tags: ['Events'],
    request: {
      params: z.object({
        channelId: z.string(),
      }),
      query: z.object({
        since: z.string().optional(),
        cursor: z.string().optional(),
        type: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Polled events',
        content: {
          'application/json': {
            schema: z.object({
              events: z.array(
                z.object({
                  id: z.string(),
                  channel_id: z.string(),
                  type: z.string().nullable(),
                  data: z.string(),
                  publisher_id: z.string().nullable(),
                  created_at: z.string(),
                }),
              ),
              cursor: z.string().nullable(),
              has_more: z.boolean(),
            }),
          },
        },
      },
    },
  };

  async handle(c: Context<Env>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { channelId } = data.params;
    const db = c.env.DB;

    await cleanupExpiredEvents(db, channelId);

    const { since, cursor, type, limit } = data.query;

    const result = await pollEvents(db, channelId, {
      since,
      cursor,
      type,
      limit,
    });

    if (c.get('channelIsPublic')) {
      const maxAge = parseInt(c.env.ZOOID_POLL_INTERVAL ?? '2', 10);
      c.header('Cache-Control', `public, s-maxage=${maxAge}`);
    }

    return c.json(result);
  }
}

async function deliverToWebhooks(
  env: Bindings,
  channelId: string,
  event: { id: string; type: string | null },
) {
  const webhooks = await getWebhooksForChannel(
    env.DB,
    channelId,
    event.type ?? undefined,
  );

  if (webhooks.length === 0) return;

  const signingKey = env.ZOOID_SIGNING_KEY
    ? await importPrivateKey(env.ZOOID_SIGNING_KEY)
    : null;

  const body = JSON.stringify(event as unknown as Record<string, unknown>);
  const timestamp = new Date().toISOString();

  const signature = signingKey
    ? await signPayload(signingKey, timestamp, body)
    : null;

  await Promise.allSettled(
    webhooks.map((webhook) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Zooid-Timestamp': timestamp,
        'X-Zooid-Channel': channelId,
        'X-Zooid-Event-Id': event.id,
        'X-Zooid-Key-Id': env.ZOOID_SERVER_ID || 'zooid-local',
      };

      if (signature) {
        headers['X-Zooid-Signature'] = signature;
      }

      return fetch(webhook.url, { method: 'POST', headers, body });
    }),
  );
}
