import { OpenAPIRoute } from 'chanfana';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../types';
import { getChannel } from '../db/queries';
import { importPrivateKey } from '../lib/signing';

type Env = { Bindings: Bindings; Variables: Variables };

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class DirectoryClaim extends OpenAPIRoute {
  schema = {
    summary: 'Generate a signed claim for the Zooid Directory',
    tags: ['Directory'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              channels: z.array(z.string()).min(1),
              action: z.enum(['delete']).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Signed claim',
        content: {
          'application/json': {
            schema: z.object({
              claim: z.string(),
              signature: z.string(),
            }),
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
      500: {
        description: 'Server error',
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
    const { channels, action } = data.body;

    if (!c.env.ZOOID_SIGNING_KEY) {
      return c.json({ error: 'Server signing key not configured' }, 500);
    }

    // Validate all channels exist
    const missing: string[] = [];
    for (const id of channels) {
      const ch = await getChannel(c.env.DB, id);
      if (!ch) missing.push(id);
    }
    if (missing.length > 0) {
      return c.json(
        { error: `Channels not found: ${missing.join(', ')}` },
        400,
      );
    }

    const serverUrl = new URL(c.req.url).origin;
    const claim: Record<string, unknown> = {
      server_url: serverUrl,
      channels,
      timestamp: new Date().toISOString(),
    };
    if (action) {
      claim.action = action;
    }

    const claimJson = JSON.stringify(claim);
    const claimBytes = new TextEncoder().encode(claimJson);
    const privateKey = await importPrivateKey(c.env.ZOOID_SIGNING_KEY);
    const signatureBuffer = await crypto.subtle.sign(
      'Ed25519',
      privateKey,
      claimBytes,
    );

    return c.json({
      claim: toBase64Url(claimJson),
      signature: arrayBufferToBase64Url(signatureBuffer),
    });
  }
}
