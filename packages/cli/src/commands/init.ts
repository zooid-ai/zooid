import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { printSuccess, printError, printInfo } from '../lib/output';

export interface ZooidServerConfig {
  name: string;
  description: string;
  owner: string;
  company: string;
  email: string;
  tags: string[];
  url: string;
}

const CONFIG_FILENAME = 'zooid.json';

function getConfigPath(): string {
  return path.join(process.cwd(), CONFIG_FILENAME);
}

export function loadServerConfig(): ZooidServerConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as ZooidServerConfig;
}

export function saveServerConfig(config: ZooidServerConfig): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export async function runInit(): Promise<void> {
  const configPath = getConfigPath();
  const existing = loadServerConfig();

  if (existing) {
    printInfo('Found existing', configPath);
    console.log('');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('  Configure your Zooid server');
    console.log('  Press Enter to accept defaults shown in [brackets].\n');

    const name = await ask(rl, 'Server name', existing?.name ?? '');
    const description = await ask(
      rl,
      'Description',
      existing?.description ?? '',
    );
    const owner = await ask(rl, 'Owner', existing?.owner ?? '');
    const company = await ask(rl, 'Company', existing?.company ?? '');
    const email = await ask(rl, 'Email', existing?.email ?? '');
    const tagsRaw = await ask(
      rl,
      'Tags (comma-separated)',
      existing?.tags?.join(', ') ?? '',
    );
    const url = await ask(rl, 'URL', existing?.url ?? '');

    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const config: ZooidServerConfig = {
      name,
      description,
      owner,
      company,
      email,
      tags,
      url,
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    console.log('');
    printSuccess(`Saved ${CONFIG_FILENAME}`);
    console.log('');
    printInfo('Name', config.name || '(not set)');
    printInfo('Description', config.description || '(not set)');
    printInfo('Owner', config.owner || '(not set)');
    printInfo('Company', config.company || '(not set)');
    printInfo('Email', config.email || '(not set)');
    printInfo(
      'Tags',
      config.tags.length > 0 ? config.tags.join(', ') : '(none)',
    );
    printInfo('URL', config.url || '(not set)');
    console.log('');
  } finally {
    rl.close();
  }
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
