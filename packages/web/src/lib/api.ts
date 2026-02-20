export interface ChannelInfo {
  id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  event_count: number;
  last_event_at: string | null;
  publishers: string[];
}

export interface ZooidEvent {
  id: string;
  channel_id: string;
  publisher_id: string | null;
  type: string | null;
  data: string;
  created_at: string;
}

export interface PollResult {
  events: ZooidEvent[];
  cursor: string | null;
  has_more: boolean;
}

function headers(token?: string): HeadersInit {
  const h: Record<string, string> = {};
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
  }
  return h;
}

export async function listChannels(baseUrl: string): Promise<ChannelInfo[]> {
  const res = await fetch(`${baseUrl}/api/v1/channels`);
  if (!res.ok) return [];
  const data: { channels: ChannelInfo[] } = await res.json();
  return data.channels;
}

export async function getChannel(
  baseUrl: string,
  channelId: string,
  token?: string,
): Promise<ChannelInfo | null> {
  // Channel list endpoint returns all channels; find ours
  const res = await fetch(`${baseUrl}/api/v1/channels`, {
    headers: headers(token),
  });

  if (!res.ok) return null;

  const data: { channels: ChannelInfo[] } = await res.json();
  return data.channels.find((ch) => ch.id === channelId) ?? null;
}

export interface ServerMeta {
  server_name: string;
  server_description: string | null;
  poll_interval: number;
  delivery: string[];
}

const defaultMeta: ServerMeta = {
  server_name: 'Zooid',
  server_description: null,
  poll_interval: 5,
  delivery: ['poll'],
};

export async function fetchServerMeta(baseUrl: string): Promise<ServerMeta> {
  try {
    const res = await fetch(`${baseUrl}/.well-known/zooid.json`);
    if (!res.ok) return defaultMeta;
    const data = await res.json();
    return {
      server_name: data.server_name ?? 'Zooid',
      server_description: data.server_description ?? null,
      poll_interval: data.poll_interval ?? 5,
      delivery: Array.isArray(data.delivery) ? data.delivery : ['poll'],
    };
  } catch {
    return defaultMeta;
  }
}

export async function pollEvents(
  baseUrl: string,
  channelId: string,
  options: { cursor?: string; since?: string; limit?: number; token?: string },
): Promise<PollResult> {
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.since) params.set('since', options.since);
  if (options.limit) params.set('limit', String(options.limit));

  const qs = params.toString();
  const url = `${baseUrl}/api/v1/channels/${channelId}/events${qs ? `?${qs}` : ''}`;

  const res = await fetch(url, {
    headers: headers(options.token),
  });

  if (!res.ok) {
    return { events: [], cursor: null, has_more: false };
  }

  return res.json();
}
