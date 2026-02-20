import { OpenAPIRoute } from 'chanfana';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../types';
import { getServerMeta, upsertServerMeta } from '../db/queries';

type Env = { Bindings: Bindings; Variables: Variables };

export class GetServerMeta extends OpenAPIRoute {
  schema = {
    summary: 'Get server metadata',
    tags: ['Server'],
    responses: {
      200: {
        description: 'Server metadata',
        content: {
          'application/json': {
            schema: z.object({
              name: z.string(),
              description: z.string().nullable(),
              tags: z.array(z.string()),
              owner: z.string().nullable(),
              company: z.string().nullable(),
              email: z.string().nullable(),
              updated_at: z.string(),
            }),
          },
        },
      },
    },
  };

  async handle(c: Context<Env>) {
    const meta = await getServerMeta(c.env.DB);

    if (!meta) {
      return c.json({
        name: 'Zooid',
        description: null,
        tags: [],
        owner: null,
        company: null,
        email: null,
        updated_at: new Date().toISOString(),
      });
    }

    return c.json(meta);
  }
}

export class UpdateServerMeta extends OpenAPIRoute {
  schema = {
    summary: 'Update server metadata',
    tags: ['Server'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1).optional(),
              description: z.string().nullable().optional(),
              tags: z.array(z.string()).optional(),
              owner: z.string().nullable().optional(),
              company: z.string().nullable().optional(),
              email: z.string().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Updated server metadata',
        content: {
          'application/json': {
            schema: z.object({
              name: z.string(),
              description: z.string().nullable(),
              tags: z.array(z.string()),
              owner: z.string().nullable(),
              company: z.string().nullable(),
              email: z.string().nullable(),
              updated_at: z.string(),
            }),
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
    },
  };

  async handle(c: Context<Env>) {
    const data = await this.getValidatedData<typeof this.schema>();
    const body = data.body;

    const meta = await upsertServerMeta(c.env.DB, body);
    return c.json(meta);
  }
}
