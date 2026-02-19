import type { PollOptions } from '@zooid/sdk';
import { createSubscribeClient } from '../lib/client';
import type { ZooidClient } from '@zooid/sdk';

export interface TailOptions {
  limit?: number;
  type?: string;
  since?: string;
  cursor?: string;
}

export async function runTail(
  channelId: string,
  options: TailOptions = {},
  client?: ZooidClient,
) {
  const c = client ?? createSubscribeClient(channelId);

  const pollOpts: PollOptions = {};
  if (options.limit !== undefined) pollOpts.limit = options.limit;
  if (options.type) pollOpts.type = options.type;
  if (options.since) pollOpts.since = options.since;
  if (options.cursor) pollOpts.cursor = options.cursor;

  return c.tail(channelId, pollOpts);
}
