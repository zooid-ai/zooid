import { createClient } from '../lib/client';
import { loadConfig } from '../lib/config';
import { directoryFetch } from '../lib/directory';

export async function runUnshare(channelId: string): Promise<void> {
  const client = createClient();
  const config = loadConfig();
  const serverUrl = config.server;

  if (!serverUrl) {
    throw new Error(
      'No server configured. Run: npx zooid config set server <url>',
    );
  }

  // Get a signed delete claim from the server
  const { claim, signature } = await client.getClaim([channelId], 'delete');

  // Submit to directory
  const res = await directoryFetch('/api/servers/channels', {
    method: 'DELETE',
    body: JSON.stringify({
      server_url: serverUrl,
      channel_id: channelId,
      claim,
      signature,
    }),
  });

  if (!res.ok) {
    throw new Error(await formatDirectoryError(res));
  }
}

async function formatDirectoryError(res: Response): Promise<string> {
  let msg = `Directory returned ${res.status}`;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const parts: string[] = [];
    if (body.error) parts.push(String(body.error));
    if (body.message) parts.push(String(body.message));
    if (parts.length > 0) msg = parts.join(': ');
  } catch {
    // use default
  }
  return msg;
}
