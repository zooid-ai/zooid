import { ZooidClient } from '@zooid/sdk';
import type { ZooidEvent, WebhookResult, SubscribeMode } from '@zooid/sdk';
import { createSubscribeClient } from '../lib/client';

export interface SubscribePollOptions {
  interval?: number;
  mode?: SubscribeMode;
  type?: string;
  callback?: (event: ZooidEvent) => void;
}

export async function runSubscribePoll(
  channelId: string,
  options: SubscribePollOptions = {},
  client?: ZooidClient,
): Promise<() => void> {
  const c = client ?? createSubscribeClient(channelId);

  const callback =
    options.callback ??
    ((event: ZooidEvent) => {
      console.log(JSON.stringify(event));
    });

  return c.subscribe(channelId, callback, {
    interval: options.interval ?? 5000,
    mode: options.mode,
    type: options.type,
  });
}

export async function runSubscribeWebhook(
  channelId: string,
  url: string,
  client?: ZooidClient,
): Promise<WebhookResult> {
  const c = client ?? createSubscribeClient(channelId);
  return c.registerWebhook(channelId, url);
}
