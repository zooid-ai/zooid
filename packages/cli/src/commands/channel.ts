import {
  ZooidClient,
  type CreateChannelResult,
  type PublisherResult,
} from '@zooid/sdk';
import type { ChannelListItem } from '@zooid/types';
import { createClient } from '../lib/client';
import { loadConfig, saveConfig } from '../lib/config';

export interface ChannelCreateOptions {
  name?: string;
  description?: string;
  public?: boolean;
  strict?: boolean;
  schema?: Record<string, unknown>;
}

export async function runChannelCreate(
  id: string,
  options: ChannelCreateOptions,
  client?: ZooidClient,
): Promise<CreateChannelResult> {
  const c = client ?? createClient();
  const result = await c.createChannel({
    id,
    name: options.name ?? id,
    description: options.description,
    is_public: options.public ?? true,
    strict: options.strict,
    schema: options.schema,
  });

  // Save tokens to config (only when using real config, not injected client)
  if (!client) {
    const config = loadConfig();
    const channels = config.channels ?? {};
    channels[id] = {
      publish_token: result.publish_token,
      subscribe_token: result.subscribe_token,
    };
    saveConfig({ channels });
  }

  return result;
}

export async function runChannelList(
  client?: ZooidClient,
): Promise<ChannelListItem[]> {
  const c = client ?? createClient();
  return c.listChannels();
}

export async function runChannelAddPublisher(
  channelId: string,
  name: string,
  client?: ZooidClient,
): Promise<PublisherResult> {
  const c = client ?? createClient();
  return c.addPublisher(channelId, name);
}
