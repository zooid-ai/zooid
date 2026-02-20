import { Command } from 'commander';
import { runConfigSet, runConfigGet } from './commands/config';
import {
  runChannelCreate,
  runChannelList,
  runChannelAddPublisher,
} from './commands/channel';
import { runPublish } from './commands/publish';
import { runSubscribePoll, runSubscribeWebhook } from './commands/subscribe';
import { runTail } from './commands/tail';
import { runStatus } from './commands/status';
import { runShare } from './commands/share';
import { runUnshare } from './commands/unshare';
import { runDiscover } from './commands/discover';
import { runServerGet, runServerSet } from './commands/server';
import { runDev } from './commands/dev';
import { runInit } from './commands/init';
import { runDeploy } from './commands/deploy';
import { printSuccess, printError, printInfo } from './lib/output';
import {
  isEnabled as telemetryEnabled,
  showNoticeIfNeeded,
  writeEvent,
  flushInBackground,
  getInstallId,
} from './lib/telemetry';
import { loadConfig } from './lib/config';
import { resolveChannel } from './lib/client';
import type { TelemetryEvent } from './lib/telemetry';

const program = new Command();

program.name('zooid').description('🪸 Pub/sub for AI agents').version('0.0.0');

// --- telemetry hooks ---

/** Shared state for the current command's telemetry context. */
const telemetryCtx: {
  startTime: number;
  channelId?: string;
  /** True if the command used a token (channel is private / not reportable). */
  usedToken?: boolean;
} = { startTime: 0 };

/**
 * Commands that interact with channels call this to report channel context.
 * If a token was used, channel info is redacted from telemetry.
 */
export function setTelemetryChannel(channelId: string): void {
  telemetryCtx.channelId = channelId;

  // Check if a token was needed — if so, channel is private, don't report it
  const config = loadConfig();
  const channelTokens = config.channels?.[channelId];
  const hasChannelToken = !!(
    channelTokens?.publish_token || channelTokens?.subscribe_token
  );
  telemetryCtx.usedToken = hasChannelToken || !!config.admin_token;
}

/** Build the full command path (e.g. "channel create", "publish"). */
function getCommandPath(cmd: Command): string {
  const parts: string[] = [];
  let current: Command | null = cmd;
  while (current && current !== program) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

/** Handle a command error: send telemetry, print, and exit. */
function handleError(commandName: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  sendTelemetry(commandName, 1, message);
  printError(message);
  process.exit(1);
}

program.hook('preAction', () => {
  telemetryCtx.startTime = Date.now();
  if (telemetryEnabled()) {
    showNoticeIfNeeded();
  }
});

/** Send a telemetry event (success or error). */
function sendTelemetry(
  commandName: string,
  exitCode: number,
  error?: string,
): void {
  if (!telemetryEnabled()) return;

  try {
    const event: TelemetryEvent = {
      install_id: getInstallId(),
      command: commandName,
      exit_code: exitCode,
      duration_ms: Date.now() - telemetryCtx.startTime,
      cli_version: program.version() ?? '0.0.0',
      os: process.platform,
      arch: process.arch,
      node_version: process.version,
      ts: new Date().toISOString(),
    };

    if (error) event.error = error;

    // Include channel/server info only for public channels (no token used)
    if (telemetryCtx.channelId && !telemetryCtx.usedToken) {
      event.channel_id = telemetryCtx.channelId;
      const config = loadConfig();
      if (config.server) event.server_url = config.server;
    }

    writeEvent(event);
    flushInBackground();
  } catch {
    // Best-effort
  }

  // Reset context
  telemetryCtx.channelId = undefined;
  telemetryCtx.usedToken = undefined;
}

program.hook('postAction', (_thisCommand, actionCommand) => {
  sendTelemetry(getCommandPath(actionCommand), 0);
});

// --- dev ---
program
  .command('dev')
  .description('Start local development server')
  .option('--port <port>', 'Server port', '8787')
  .action(async (opts) => {
    try {
      await runDev(parseInt(opts.port, 10));
    } catch (err) {
      handleError('dev', err);
    }
  });

// --- init ---
program
  .command('init')
  .description('Create zooid-server.json with server identity')
  .action(async () => {
    try {
      await runInit();
    } catch (err) {
      handleError('init', err);
    }
  });

// --- deploy ---
program
  .command('deploy')
  .description('Deploy Zooid server to Cloudflare Workers')
  .action(async () => {
    try {
      await runDeploy();
    } catch (err) {
      handleError('deploy', err);
    }
  });

// --- config ---
const configCmd = program
  .command('config')
  .description('Manage Zooid configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (server, admin-token, telemetry)')
  .action((key, value) => {
    try {
      runConfigSet(key, value);
      printSuccess(`Set ${key}`);
    } catch (err) {
      handleError('config set', err);
    }
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key) => {
    try {
      const value = runConfigGet(key);
      if (value) {
        console.log(value);
      } else {
        console.log('(not set)');
      }
    } catch (err) {
      handleError('config get', err);
    }
  });

// --- channel ---
const channelCmd = program.command('channel').description('Manage channels');

channelCmd
  .command('create <id>')
  .description('Create a new channel')
  .option('--name <name>', 'Display name (defaults to id)')
  .option('--description <desc>', 'Channel description')
  .option('--public', 'Make channel public (default)', true)
  .option('--private', 'Make channel private')
  .option('--strict', 'Enable strict schema validation on publish')
  .option('--schema <file>', 'Path to JSON schema file')
  .action(async (id, opts) => {
    try {
      let schema: Record<string, unknown> | undefined;
      if (opts.schema) {
        const fs = await import('node:fs');
        const raw = fs.readFileSync(opts.schema, 'utf-8');
        schema = JSON.parse(raw);
      }
      const result = await runChannelCreate(id, {
        name: opts.name,
        description: opts.description,
        public: opts.private ? false : true,
        strict: opts.strict,
        schema,
      });
      printSuccess(`Created channel: ${id}`);
      printInfo('Publish token', result.publish_token);
      printInfo('Subscribe token', result.subscribe_token);
    } catch (err) {
      handleError('channel create', err);
    }
  });

channelCmd
  .command('list')
  .description('List all channels')
  .action(async () => {
    try {
      const channels = await runChannelList();
      if (channels.length === 0) {
        console.log(
          'No channels yet. Create one with: npx zooid channel create <name>',
        );
      } else {
        for (const ch of channels) {
          const visibility = ch.is_public ? 'public' : 'private';
          console.log(
            `  ${ch.id} — ${ch.name} (${visibility}, ${ch.event_count} events)`,
          );
        }
      }
    } catch (err) {
      handleError('channel list', err);
    }
  });

channelCmd
  .command('add-publisher <channel>')
  .description('Add a publisher to a channel')
  .requiredOption('--name <name>', 'Publisher name')
  .action(async (channel, opts) => {
    try {
      const result = await runChannelAddPublisher(channel, opts.name);
      printSuccess(`Added publisher: ${result.name}`);
      printInfo('Publisher ID', result.id);
      printInfo('Publish token', result.publish_token);
    } catch (err) {
      handleError('channel add-publisher', err);
    }
  });

// --- publish ---
program
  .command('publish <channel>')
  .description('Publish an event to a channel')
  .option('--type <type>', 'Event type')
  .option('--data <json>', 'Event data as JSON string')
  .option('--file <path>', 'Read event from JSON file')
  .option('--token <token>', 'Auth token (for remote/private channels)')
  .action(async (channel, opts) => {
    try {
      const { client, channelId, tokenSaved } = resolveChannel(channel, {
        token: opts.token,
        tokenType: 'publish',
      });
      setTelemetryChannel(channelId);
      if (tokenSaved) {
        printInfo(
          'Token saved',
          `for ${channelId} — won't need --token next time`,
        );
      }
      const event = await runPublish(channelId, opts, client);
      printSuccess(`Published event: ${event.id}`);
    } catch (err) {
      handleError('publish', err);
    }
  });

// --- tail ---
program
  .command('tail <channel>')
  .description('Fetch latest events, or stream live with -f')
  .option('-n, --limit <n>', 'Max events to return', '50')
  .option('-f, --follow', 'Follow mode — stream new events as they arrive')
  .option('--type <type>', 'Filter events by type')
  .option('--since <iso>', 'Only events after this ISO 8601 timestamp')
  .option('--cursor <cursor>', 'Resume from a previous cursor')
  .option(
    '--mode <mode>',
    'Transport mode for follow: auto, ws, or poll',
    'auto',
  )
  .option('--interval <ms>', 'Poll interval in ms for follow mode', '5000')
  .option('--token <token>', 'Auth token (for remote/private channels)')
  .action(async (channel, opts) => {
    try {
      const { client, channelId, tokenSaved } = resolveChannel(channel, {
        token: opts.token,
        tokenType: 'subscribe',
      });
      setTelemetryChannel(channelId);
      if (tokenSaved) {
        printInfo(
          'Token saved',
          `for ${channelId} — won't need --token next time`,
        );
      }
      if (opts.follow) {
        const mode = opts.mode as 'auto' | 'ws' | 'poll';
        const transport =
          mode === 'auto' ? 'auto (WebSocket → poll fallback)' : mode;
        console.log(
          `Tailing ${channelId} [${transport}]${opts.type ? ` type=${opts.type}` : ''}...`,
        );
        console.log('Press Ctrl+C to stop.\n');
        await runTail(
          channelId,
          {
            follow: true,
            mode,
            interval: parseInt(opts.interval, 10),
            type: opts.type,
          },
          client,
        );
      } else {
        const result = await runTail(
          channelId,
          {
            limit: parseInt(opts.limit, 10),
            type: opts.type,
            since: opts.since,
            cursor: opts.cursor,
          },
          client,
        );
        if (result.events.length === 0) {
          console.log('No events.');
        } else {
          for (const event of result.events) {
            console.log(JSON.stringify(event));
          }
        }
        if (result.cursor) {
          printInfo('Cursor', result.cursor);
        }
      }
    } catch (err) {
      handleError('tail', err);
    }
  });

// --- subscribe ---
program
  .command('subscribe <channel>')
  .description('Subscribe to a channel')
  .option('--webhook <url>', 'Register a webhook instead of polling')
  .option('--interval <ms>', 'Poll interval in milliseconds', '5000')
  .option('--mode <mode>', 'Transport mode: auto, ws, or poll', 'auto')
  .option('--type <type>', 'Filter events by type')
  .option('--token <token>', 'Auth token (for remote/private channels)')
  .action(async (channel, opts) => {
    try {
      const { client, channelId, tokenSaved } = resolveChannel(channel, {
        token: opts.token,
        tokenType: 'subscribe',
      });
      setTelemetryChannel(channelId);
      if (tokenSaved) {
        printInfo(
          'Token saved',
          `for ${channelId} — won't need --token next time`,
        );
      }
      if (opts.webhook) {
        const wh = await runSubscribeWebhook(channelId, opts.webhook, client);
        printSuccess(`Registered webhook: ${wh.id}`);
        printInfo('URL', wh.url);
        printInfo('Expires', wh.expires_at);
      } else {
        const mode = opts.mode as 'auto' | 'ws' | 'poll';
        const transport =
          mode === 'auto' ? 'auto (WebSocket → poll fallback)' : mode;
        console.log(
          `Subscribing to ${channelId} [${transport}]${opts.type ? ` type=${opts.type}` : ''}...`,
        );
        console.log('Press Ctrl+C to stop.\n');
        await runSubscribePoll(
          channelId,
          {
            interval: parseInt(opts.interval, 10),
            mode,
            type: opts.type,
          },
          client,
        );
        // Keep process alive
        await new Promise(() => {});
      }
    } catch (err) {
      handleError('subscribe', err);
    }
  });

// --- server ---
const serverCmd = program
  .command('server')
  .description('Manage server metadata');

serverCmd
  .command('get')
  .description('Show server metadata')
  .action(async () => {
    try {
      const meta = await runServerGet();
      console.log(`\n  ${meta.name}\n`);
      if (meta.description) printInfo('Description', meta.description);
      if (meta.tags.length > 0) printInfo('Tags', meta.tags.join(', '));
      if (meta.owner) printInfo('Owner', meta.owner);
      if (meta.company) printInfo('Company', meta.company);
      if (meta.email) printInfo('Email', meta.email);
      printInfo('Updated', meta.updated_at);
      console.log('');
    } catch (err) {
      handleError('server get', err);
    }
  });

serverCmd
  .command('set')
  .description('Update server metadata')
  .option('--name <name>', 'Server name')
  .option('--description <desc>', 'Server description')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--owner <owner>', 'Server owner')
  .option('--company <company>', 'Company name')
  .option('--email <email>', 'Contact email')
  .action(async (opts) => {
    try {
      const fields: Record<string, unknown> = {};
      if (opts.name !== undefined) fields.name = opts.name;
      if (opts.description !== undefined) fields.description = opts.description;
      if (opts.tags !== undefined)
        fields.tags = opts.tags.split(',').map((t: string) => t.trim());
      if (opts.owner !== undefined) fields.owner = opts.owner;
      if (opts.company !== undefined) fields.company = opts.company;
      if (opts.email !== undefined) fields.email = opts.email;

      if (Object.keys(fields).length === 0) {
        throw new Error(
          'No fields specified. Use --name, --description, --tags, --owner, --company, or --email.',
        );
      }

      const meta = await runServerSet(fields);
      printSuccess(`Updated server metadata`);
      printInfo('Name', meta.name);
      console.log('');
    } catch (err) {
      handleError('server set', err);
    }
  });

// --- status ---
program
  .command('status')
  .description('Check server status')
  .action(async () => {
    try {
      const { discovery, identity } = await runStatus();
      console.log(`\n  ${identity.name} v${discovery.version}\n`);
      printInfo('Server ID', discovery.server_id);
      printInfo('Algorithm', discovery.algorithm);
      printInfo('Poll interval', `${discovery.poll_interval}s`);
      printInfo('Delivery', discovery.delivery.join(', '));
      console.log('');
    } catch (err) {
      handleError('status', err);
    }
  });

// --- share ---
program
  .command('share [channels...]')
  .description('List channels in the Zooid Directory')
  .option('--channel <id>', 'Channel to share (alternative to positional args)')
  .option('-y, --yes', 'Skip prompts, use server values for description/tags')
  .action(async (channels: string[], opts) => {
    try {
      const ids = opts.channel ? [opts.channel, ...channels] : channels;
      await runShare(ids, { yes: opts.yes });
      printSuccess('Channels shared to directory');
    } catch (err) {
      handleError('share', err);
    }
  });

// --- discover ---
program
  .command('discover')
  .description('Browse public channels in the Zooid Directory')
  .option('-q, --query <text>', 'Search by keyword')
  .option('-t, --tag <tag>', 'Filter by tag')
  .option('-n, --limit <n>', 'Max results', '20')
  .action(async (opts) => {
    try {
      await runDiscover({
        query: opts.query,
        tag: opts.tag,
        limit: parseInt(opts.limit, 10),
      });
    } catch (err) {
      handleError('discover', err);
    }
  });

// --- unshare ---
program
  .command('unshare <channel>')
  .description('Remove a channel from the Zooid Directory')
  .action(async (channel: string) => {
    try {
      await runUnshare(channel);
      printSuccess(`Removed ${channel} from directory`);
    } catch (err) {
      handleError('unshare', err);
    }
  });

program.parse();
