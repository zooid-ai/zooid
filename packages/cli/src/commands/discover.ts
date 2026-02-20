import { DIRECTORY_BASE_URL } from '../lib/directory';

export interface DiscoverOptions {
  tag?: string;
  query?: string;
  limit?: number;
}

interface DiscoverChannel {
  channel_id: string;
  name: string;
  description: string | null;
  server_url: string;
  server_name: string;
  tags: string[];
  owner: string | null;
  last_event_at: string | null;
  is_alive: boolean;
}

interface DiscoverResult {
  channels: DiscoverChannel[];
  total: number;
}

export async function runDiscover(options: DiscoverOptions): Promise<void> {
  const params = new URLSearchParams();
  if (options.query) params.set('q', options.query);
  if (options.tag) params.set('tag', options.tag);
  if (options.limit) params.set('limit', String(options.limit));

  const qs = params.toString();
  const url = `${DIRECTORY_BASE_URL}/api/discover${qs ? `?${qs}` : ''}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Directory returned ${res.status}`);
  }

  const data = (await res.json()) as DiscoverResult;

  if (data.channels.length === 0) {
    console.log('No channels found.');
    return;
  }

  console.log('');
  for (const ch of data.channels) {
    const host = new URL(ch.server_url).host;
    const tags = ch.tags.length > 0 ? ` [${ch.tags.join(', ')}]` : '';
    const desc = ch.description ? ` — ${ch.description}` : '';
    console.log(`  ${host}/${ch.channel_id}${desc}${tags}`);
  }
  console.log(`\n  ${data.total} channel${data.total === 1 ? '' : 's'} found.`);
  console.log('');
}
