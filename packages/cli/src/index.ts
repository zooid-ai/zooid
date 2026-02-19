import { Command } from 'commander';
import { runConfigSet, runConfigGet } from './commands/config';
import { runChannelCreate, runChannelList, runChannelAddPublisher } from './commands/channel';
import { runPublish } from './commands/publish';
import { runSubscribePoll, runSubscribeWebhook } from './commands/subscribe';
import { runStatus } from './commands/status';
import { runServerGet, runServerSet } from './commands/server';
import { runDev } from './commands/dev';
import { runInit } from './commands/init';
import { runDeploy } from './commands/deploy';
import { printSuccess, printError, printInfo } from './lib/output';

const program = new Command();

program
  .name('zooid')
  .description('Pub/sub for AI agents')
  .version('0.0.0');

// --- dev ---
program
  .command('dev')
  .description('Start local development server')
  .option('--port <port>', 'Server port', '8787')
  .action(async (opts) => {
    try {
      await runDev(parseInt(opts.port, 10));
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
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
      printError((err as Error).message);
      process.exit(1);
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
      printError((err as Error).message);
      process.exit(1);
    }
  });

// --- config ---
const configCmd = program
  .command('config')
  .description('Manage Zooid configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (server, admin-token)')
  .action((key, value) => {
    try {
      runConfigSet(key, value);
      printSuccess(`Set ${key}`);
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
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
      printError((err as Error).message);
      process.exit(1);
    }
  });

// --- channel ---
const channelCmd = program
  .command('channel')
  .description('Manage channels');

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
      printError((err as Error).message);
      process.exit(1);
    }
  });

channelCmd
  .command('list')
  .description('List all channels')
  .action(async () => {
    try {
      const channels = await runChannelList();
      if (channels.length === 0) {
        console.log('No channels yet. Create one with: npx zooid channel create <name>');
      } else {
        for (const ch of channels) {
          const visibility = ch.is_public ? 'public' : 'private';
          console.log(`  ${ch.id} — ${ch.name} (${visibility}, ${ch.event_count} events)`);
        }
      }
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
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
      printError((err as Error).message);
      process.exit(1);
    }
  });

// --- publish ---
program
  .command('publish <channel>')
  .description('Publish an event to a channel')
  .option('--type <type>', 'Event type')
  .option('--data <json>', 'Event data as JSON string')
  .option('--file <path>', 'Read event from JSON file')
  .action(async (channel, opts) => {
    try {
      const event = await runPublish(channel, opts);
      printSuccess(`Published event: ${event.id}`);
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
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
  .action(async (channel, opts) => {
    try {
      if (opts.webhook) {
        const wh = await runSubscribeWebhook(channel, opts.webhook);
        printSuccess(`Registered webhook: ${wh.id}`);
        printInfo('URL', wh.url);
        printInfo('Expires', wh.expires_at);
      } else {
        const mode = opts.mode as 'auto' | 'ws' | 'poll';
        const transport = mode === 'auto' ? 'auto (WebSocket → poll fallback)' : mode;
        console.log(`Subscribing to ${channel} [${transport}]${opts.type ? ` type=${opts.type}` : ''}...`);
        console.log('Press Ctrl+C to stop.\n');
        await runSubscribePoll(channel, {
          interval: parseInt(opts.interval, 10),
          mode,
          type: opts.type,
        });
        // Keep process alive
        await new Promise(() => {});
      }
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
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
      printError((err as Error).message);
      process.exit(1);
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
      if (opts.tags !== undefined) fields.tags = opts.tags.split(',').map((t: string) => t.trim());
      if (opts.owner !== undefined) fields.owner = opts.owner;
      if (opts.company !== undefined) fields.company = opts.company;
      if (opts.email !== undefined) fields.email = opts.email;

      if (Object.keys(fields).length === 0) {
        printError('No fields specified. Use --name, --description, --tags, --owner, --company, or --email.');
        process.exit(1);
      }

      const meta = await runServerSet(fields);
      printSuccess(`Updated server metadata`);
      printInfo('Name', meta.name);
      console.log('');
    } catch (err) {
      printError((err as Error).message);
      process.exit(1);
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
      printError((err as Error).message);
      process.exit(1);
    }
  });

program.parse();
