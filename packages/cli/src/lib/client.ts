import { ZooidClient } from '@zooid/sdk';
import { loadConfig } from './config';

export function createClient(token?: string): ZooidClient {
  const config = loadConfig();
  const server = config.server;

  if (!server) {
    throw new Error(
      'No server configured. Run: npx zooid config set server <url>',
    );
  }

  return new ZooidClient({ server, token: token ?? config.admin_token });
}

export function createPublishClient(channelId: string): ZooidClient {
  const config = loadConfig();
  const server = config.server;

  if (!server) {
    throw new Error(
      'No server configured. Run: npx zooid config set server <url>',
    );
  }

  const channelToken = config.channels?.[channelId]?.publish_token;
  return new ZooidClient({ server, token: channelToken ?? config.admin_token });
}

export function createSubscribeClient(channelId: string): ZooidClient {
  const config = loadConfig();
  const server = config.server;

  if (!server) {
    throw new Error(
      'No server configured. Run: npx zooid config set server <url>',
    );
  }

  const channelToken = config.channels?.[channelId]?.subscribe_token;
  return new ZooidClient({ server, token: channelToken ?? config.admin_token });
}
