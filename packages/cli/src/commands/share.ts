import readline from 'node:readline/promises';
import type { ChannelListItem } from '@zooid/types';
import { createClient } from '../lib/client';
import { loadConfig } from '../lib/config';
import { directoryFetch, DIRECTORY_BASE_URL } from '../lib/directory';

export interface ShareOptions {
  yes?: boolean;
}

export async function runShare(
  channelIds: string[],
  options: ShareOptions = {},
): Promise<void> {
  const client = createClient();
  const config = loadConfig();
  const serverUrl = config.server;

  if (!serverUrl) {
    throw new Error(
      'No server configured. Run: npx zooid config set server <url>',
    );
  }

  // List all channels from the server
  const allChannels = await client.listChannels();
  const publicChannels = allChannels.filter((ch) => ch.is_public);

  if (publicChannels.length === 0) {
    throw new Error('No public channels found on this server.');
  }

  let selected: ChannelListItem[];

  if (channelIds.length > 0) {
    // Validate requested channels exist
    const byId = new Map(allChannels.map((ch) => [ch.id, ch]));
    const missing: string[] = [];
    selected = [];
    for (const id of channelIds) {
      const ch = byId.get(id);
      if (!ch) {
        missing.push(id);
      } else {
        selected.push(ch);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Channels not found: ${missing.join(', ')}`);
    }

    // Validate all selected channels are public
    const privateChannels = selected.filter((ch) => !ch.is_public);
    if (privateChannels.length > 0) {
      throw new Error(
        `Cannot share private channels: ${privateChannels.map((ch) => ch.id).join(', ')}. Only public channels can be listed in the directory.`,
      );
    }
  } else if (options.yes) {
    // --yes with no channels specified: share all public
    selected = publicChannels;
  } else {
    // Interactive: let user pick which channels to share
    selected = await pickChannels(publicChannels);
    if (selected.length === 0) {
      throw new Error('No channels selected.');
    }
  }

  // Prompt for description/tags per channel (unless --yes)
  const channelDetails = await promptChannelDetails(selected, options.yes);

  const ids = selected.map((ch) => ch.id);

  // Get a signed claim from the server
  const { claim, signature } = await client.getClaim(ids);

  // Build channel details for the directory (omit nulls)
  const channels = selected.map((ch) => {
    const details = channelDetails.get(ch.id)!;
    const entry: Record<string, unknown> = {
      channel_id: ch.id,
      name: ch.name,
    };
    if (details.description) entry.description = details.description;
    if (details.tags.length > 0) entry.tags = details.tags;
    return entry;
  });

  // Submit to directory
  const res = await directoryFetch('/api/servers', {
    method: 'POST',
    body: JSON.stringify({ server_url: serverUrl, claim, signature, channels }),
  });

  if (!res.ok) {
    throw new Error(await formatDirectoryError(res));
  }

  await res.json();

  console.log('');
  for (const ch of selected) {
    console.log(`  ${ch.id} → ${serverUrl}/${ch.id}`);
  }
  console.log('');
  console.log(`  Any zooid can find your channel using:`);
  console.log(`    npx zooid discover --query ${selected[0].id}`);
  const tags = [
    ...new Set(selected.flatMap((ch) => channelDetails.get(ch.id)?.tags ?? [])),
  ];
  if (tags.length > 0) {
    console.log(`    npx zooid discover --tag ${tags[0]}`);
  }
  console.log('');
}

/** Interactive checkbox picker using @inquirer/checkbox. */
async function pickChannels(
  channels: ChannelListItem[],
): Promise<ChannelListItem[]> {
  const { default: checkbox } = await import('@inquirer/checkbox');

  const selected = await checkbox({
    message: 'Select channels to share',
    choices: channels.map((ch) => ({
      name: ch.description ? `${ch.id} — ${ch.description}` : ch.id,
      value: ch.id,
      checked: true,
    })),
    theme: {
      icon: { cursor: '> ' },
      style: { highlight: (text: string) => text },
    },
  });

  const selectedSet = new Set(selected);
  return channels.filter((ch) => selectedSet.has(ch.id));
}

async function promptChannelDetails(
  channels: ChannelListItem[],
  skipPrompt?: boolean,
): Promise<Map<string, { description: string; tags: string[] }>> {
  const result = new Map<string, { description: string; tags: string[] }>();

  if (skipPrompt) {
    for (const ch of channels) {
      result.set(ch.id, {
        description: ch.description ?? '',
        tags: ch.tags,
      });
    }
    return result;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('  Set description and tags for each channel.');
    console.log('  Press Enter to accept defaults shown in [brackets].\n');

    for (const ch of channels) {
      console.log(`  ${ch.id}:`);

      const desc = await ask(rl, 'Description', ch.description ?? '');
      const tagsRaw = await ask(
        rl,
        'Tags (comma-separated)',
        ch.tags.join(', '),
      );
      const tags = tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      result.set(ch.id, { description: desc, tags });
      console.log('');
    }
  } finally {
    rl.close();
  }

  return result;
}

async function ask(
  rl: readline.Interface,
  label: string,
  defaultValue: string,
): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`  ${label}${hint}: `);
  return answer.trim() || defaultValue;
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
