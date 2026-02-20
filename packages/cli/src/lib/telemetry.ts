import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from './config';

const TELEMETRY_ENDPOINT = 'https://telemetry.zooid.dev/v1/events';
const QUEUE_FILENAME = 'telemetry.json';
const CONFIG_FILENAME = 'config.json';
const MAX_QUEUE_SIZE = 1000;

export interface TelemetryEvent {
  install_id: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  cli_version: string;
  os: string;
  arch: string;
  node_version: string;
  ts: string;
  /** Included only for public channel interactions (no token used). */
  channel_id?: string;
  /** Included only for public channel interactions (no token used). */
  server_url?: string;
  /** Error message when exit_code != 0. */
  error?: string;
}

/** Returns true if telemetry collection is enabled. */
export function isEnabled(): boolean {
  // Env var takes priority (supports CI and per-session override)
  const envVar = process.env.ZOOID_TELEMETRY;
  if (envVar !== undefined) {
    return (
      envVar !== '0' &&
      envVar.toLowerCase() !== 'false' &&
      envVar.toLowerCase() !== 'off'
    );
  }

  // Check config file for telemetry flag
  const flag = readTelemetryFlag();
  if (flag === false) return false;

  // Default: enabled (flag is true or undefined/first-run)
  return true;
}

/**
 * Show the first-run telemetry notice if it hasn't been shown yet.
 * Returns true if the notice was shown (first run).
 */
export function showNoticeIfNeeded(): boolean {
  if (process.env.ZOOID_TELEMETRY === '0') return false;

  const flag = readTelemetryFlag();
  if (flag !== undefined) return false; // Already seen notice

  console.log('');
  console.log('  Zooid collects anonymous usage metrics to improve the tool');
  console.log('  and help rank channels in the public directory.');
  console.log('');
  console.log('  To opt out: npx zooid config set telemetry off');
  console.log('  Or set ZOOID_TELEMETRY=0 in your environment.');
  console.log('');

  // Persist: user has seen notice, telemetry is on
  writeTelemetryFlag(true);
  return true;
}

/** Write a telemetry event to the local queue file. */
export function writeEvent(event: TelemetryEvent): void {
  const queuePath = getQueuePath();
  const dir = getConfigDir();

  try {
    fs.mkdirSync(dir, { recursive: true });

    let queue: TelemetryEvent[] = [];
    try {
      const raw = fs.readFileSync(queuePath, 'utf-8');
      queue = JSON.parse(raw);
    } catch {
      // File doesn't exist or is malformed — start fresh
    }

    queue.push(event);

    // Cap to prevent unbounded growth when offline
    if (queue.length > MAX_QUEUE_SIZE) {
      queue = queue.slice(-MAX_QUEUE_SIZE);
    }

    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + '\n');
  } catch {
    // Telemetry is best-effort — never crash the CLI
  }
}

/**
 * Spawn a detached background process to flush the queue.
 * The CLI exits immediately — the child process sends events and cleans up.
 */
export function flushInBackground(): void {
  const queuePath = getQueuePath();

  // Only flush if queue file exists and has content
  try {
    const raw = fs.readFileSync(queuePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;
  } catch {
    return;
  }

  try {
    const { spawn } =
      require('node:child_process') as typeof import('node:child_process');
    const child = spawn(process.execPath, ['-e', flushScript(queuePath)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  } catch {
    // Best-effort — if spawn fails, events stay queued for next run
  }
}

/** Get or create a stable anonymous install ID. */
export function getInstallId(): string {
  const configPath = path.join(getConfigDir(), CONFIG_FILENAME);

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.install_id) return parsed.install_id as string;
  } catch {
    // Config doesn't exist yet
  }

  const id = randomUUID();
  persistToConfig('install_id', id);
  return id;
}

/** Get the path to the telemetry queue file. */
export function getQueuePath(): string {
  return path.join(getConfigDir(), QUEUE_FILENAME);
}

// --- internal helpers ---

function readTelemetryFlag(): boolean | undefined {
  const configPath = path.join(getConfigDir(), CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.telemetry === true) return true;
    if (parsed.telemetry === false) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeTelemetryFlag(enabled: boolean): void {
  persistToConfig('telemetry', enabled);
}

/** Merge a key into the top-level config file without clobbering other fields. */
function persistToConfig(key: string, value: unknown): void {
  const dir = getConfigDir();
  const configPath = path.join(dir, CONFIG_FILENAME);

  try {
    fs.mkdirSync(dir, { recursive: true });
    let config: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw);
    } catch {
      // Start fresh
    }
    config[key] = value;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  } catch {
    // Best-effort
  }
}

/**
 * Inline Node.js script that the detached child process runs.
 * Reads the queue, POSTs to the telemetry endpoint, truncates on success.
 */
function flushScript(queuePath: string): string {
  return `
const fs = require('fs');
const https = require('https');
const http = require('http');

try {
  const raw = fs.readFileSync(${JSON.stringify(queuePath)}, 'utf-8');
  const events = JSON.parse(raw);
  if (!Array.isArray(events) || events.length === 0) process.exit(0);

  const body = JSON.stringify({ events });
  const url = new URL(${JSON.stringify(TELEMETRY_ENDPOINT)});
  const transport = url.protocol === 'https:' ? https : http;

  const req = transport.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 5000,
  }, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      fs.writeFileSync(${JSON.stringify(queuePath)}, '[]\\n');
    }
    process.exit(0);
  });

  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
} catch (e) {
  process.exit(0);
}
`.trim();
}
