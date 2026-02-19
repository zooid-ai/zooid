import fs from 'node:fs';
import { ZooidClient } from '@zooid/sdk';
import type { ZooidEvent } from '@zooid/types';
import { createPublishClient } from '../lib/client';

export interface PublishCommandOptions {
  type?: string;
  data?: string;
  file?: string;
}

export async function runPublish(
  channelId: string,
  options: PublishCommandOptions,
  client?: ZooidClient,
): Promise<ZooidEvent> {
  const c = client ?? createPublishClient(channelId);

  let type: string | undefined;
  let data: unknown;

  if (options.file) {
    const raw = fs.readFileSync(options.file, 'utf-8');
    const parsed = JSON.parse(raw);
    type = parsed.type;
    data = parsed.data ?? parsed;
  } else if (options.data) {
    data = JSON.parse(options.data);
    type = options.type;
  } else {
    throw new Error('Either --data or --file is required');
  }

  const publishOpts: { type?: string; data: unknown } = { data };
  if (type) publishOpts.type = type;

  return c.publish(channelId, publishOpts);
}
