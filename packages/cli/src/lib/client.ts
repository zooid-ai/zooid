import { ZooidClient } from '@zooid/sdk';
import { loadConfig, loadConfigFile, saveConfig } from './config';

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

/**
 * Parse a channel argument that may be a full URL or a plain channel ID.
 * Accepts both formats:
 *   https://server.dev/my-channel           → { server, channelId: "my-channel" }
 *   https://server.dev/channels/my-channel  → { server, channelId: "my-channel" }
 */
export function parseChannelUrl(
  channel: string,
): { server: string; channelId: string } | null {
  if (!channel.startsWith('http')) return null;
  try {
    const url = new URL(channel);
    // /channels/<id> format
    const channelsMatch = url.pathname.match(/^\/channels\/([^/]+)/);
    if (channelsMatch) {
      return { server: url.origin, channelId: channelsMatch[1] };
    }
    // Simple /<id> format (single path segment)
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 1) {
      return { server: url.origin, channelId: segments[0] };
    }
  } catch {
    // Not a valid URL
  }
  return null;
}

export interface ResolveChannelResult {
  client: ZooidClient;
  channelId: string;
  server: string;
  /** True if the token was newly saved to config. */
  tokenSaved: boolean;
}

/**
 * Resolve a channel argument (URL or plain ID) + optional token into a client.
 * When --token is explicitly provided, it's saved to config for future use.
 * On subsequent calls without --token, the saved token is used automatically.
 */
export function resolveChannel(
  channel: string,
  opts?: { token?: string; tokenType?: 'publish' | 'subscribe' },
): ResolveChannelResult {
  const parsed = parseChannelUrl(channel);

  if (parsed) {
    // Remote server URL
    const { server, channelId } = parsed;
    let token = opts?.token;
    let tokenSaved = false;

    // Save explicit token for future use
    if (token && opts?.tokenType) {
      const tokenKey =
        opts.tokenType === 'publish' ? 'publish_token' : 'subscribe_token';
      saveConfig({ channels: { [channelId]: { [tokenKey]: token } } }, server, {
        setCurrent: false,
      });
      tokenSaved = true;
    }

    // Look up saved token if none provided
    if (!token) {
      const file = loadConfigFile();
      const channelTokens = file.servers?.[server]?.channels?.[channelId];
      if (opts?.tokenType === 'publish') {
        token = channelTokens?.publish_token;
      } else {
        token = channelTokens?.subscribe_token;
      }
    }

    return {
      client: new ZooidClient({ server, token }),
      channelId,
      server,
      tokenSaved,
    };
  }

  // Plain channel ID — use current server
  const config = loadConfig();
  const server = config.server;
  if (!server) {
    throw new Error(
      'No server configured. Run: npx zooid config set server <url>',
    );
  }

  let token = opts?.token;
  let tokenSaved = false;

  // Save explicit token for future use
  if (token && opts?.tokenType) {
    const tokenKey =
      opts.tokenType === 'publish' ? 'publish_token' : 'subscribe_token';
    saveConfig({ channels: { [channel]: { [tokenKey]: token } } });
    tokenSaved = true;
  }

  // Look up token from config if none provided
  if (!token) {
    const channelTokens = config.channels?.[channel];
    if (opts?.tokenType === 'publish') {
      token = channelTokens?.publish_token ?? config.admin_token;
    } else if (opts?.tokenType === 'subscribe') {
      token = channelTokens?.subscribe_token ?? config.admin_token;
    } else {
      token = config.admin_token;
    }
  }

  return {
    client: new ZooidClient({ server, token }),
    channelId: channel,
    server,
    tokenSaved,
  };
}
