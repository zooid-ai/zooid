import type { PollOptions, TailOptions, ZooidEvent } from '@zooid/sdk';
import { createSubscribeClient } from '../lib/client';
import type { ZooidClient } from '@zooid/sdk';

export interface TailCommandOptions {
  limit?: number;
  type?: string;
  since?: string;
  cursor?: string;
  follow?: boolean;
  mode?: 'auto' | 'ws' | 'poll';
  interval?: number;
}

export async function runTail(
  channelId: string,
  options: TailCommandOptions = {},
  client?: ZooidClient,
) {
  const c = client ?? createSubscribeClient(channelId);

  if (options.follow) {
    return runTailFollow(c, channelId, options);
  }

  const pollOpts: PollOptions = {};
  if (options.limit !== undefined) pollOpts.limit = options.limit;
  if (options.type) pollOpts.type = options.type;
  if (options.since) pollOpts.since = options.since;
  if (options.cursor) pollOpts.cursor = options.cursor;

  return c.tail(channelId, pollOpts);
}

async function runTailFollow(
  client: ZooidClient,
  channelId: string,
  options: TailCommandOptions,
): Promise<never> {
  const tailOpts: TailOptions & { follow: true } = {
    follow: true,
    mode: options.mode,
    interval: options.interval,
    type: options.type,
  };

  const stream = client.tail(channelId, tailOpts);

  for await (const event of stream) {
    console.log(JSON.stringify(event));
  }

  // Stream only ends when closed externally (Ctrl+C)
  return undefined as never;
}
