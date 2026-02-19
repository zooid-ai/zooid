import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ZooidClient } from '@zooid/sdk';
import { loadConfig, saveConfig } from '../lib/config';
import { printSuccess, printError, printInfo } from '../lib/output';
import { loadServerConfig, saveServerConfig, runInit } from './init';

function findServerDir(): string {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(cliDir, '../../server');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

async function createAdminToken(secret: string): Promise<string> {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    scope: 'admin',
    iat: Math.floor(Date.now() / 1000),
  })));

  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const signature = base64url(Buffer.from(sig));

  return `${data}.${signature}`;
}

interface CfCredentials {
  apiToken: string;
  accountId?: string;
}

/** Run a wrangler command with CF credentials in env. Returns stdout. */
function wrangler(
  cmd: string,
  serverDir: string,
  creds: CfCredentials,
  opts?: { input?: string },
): string {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: creds.apiToken,
  };
  if (creds.accountId) {
    env.CLOUDFLARE_ACCOUNT_ID = creds.accountId;
  }
  return execSync(`npx wrangler ${cmd}`, {
    cwd: serverDir,
    stdio: 'pipe',
    encoding: 'utf-8',
    env,
    input: opts?.input,
  });
}

interface DeployUrls {
  workerUrl: string | null;
  customDomain: string | null;
}

function parseDeployUrls(output: string): DeployUrls {
  // wrangler deploy output looks like:
  //   https://zooid.user.workers.dev
  //   signals.example.com (custom domain)
  const workersDev = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  const custom = output.match(/^\s+(\S+\.(?!workers\.dev)\S+)\s+\(custom domain\)/m);

  return {
    workerUrl: workersDev ? workersDev[0] : null,
    customDomain: custom ? `https://${custom[1]}` : null,
  };
}

function loadDotEnv(): Partial<CfCredentials> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');

  const tokenMatch = content.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m);
  const accountMatch = content.match(/^CLOUDFLARE_ACCOUNT_ID=(.+)$/m);

  return {
    apiToken: tokenMatch ? tokenMatch[1].trim() : undefined,
    accountId: accountMatch ? accountMatch[1].trim() : undefined,
  };
}

async function getCfCredentials(): Promise<CfCredentials> {
  // 1. Environment variables
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envToken) {
    return { apiToken: envToken, accountId: envAccount };
  }

  // 2. .env file in current directory
  const dotEnv = loadDotEnv();
  if (dotEnv.apiToken) {
    printInfo('Using credentials from', '.env');
    return { apiToken: dotEnv.apiToken, accountId: dotEnv.accountId };
  }

  // 3. Prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('  Cloudflare API token required for deployment.');
    console.log('  Go to: https://dash.cloudflare.com/profile/api-tokens');
    console.log('  Use the "Edit Cloudflare Workers" template, then add D1 Edit permission.');
    console.log('  Tip: save credentials in .env to skip this prompt.');
    console.log('');
    const token = await rl.question('  API token: ');
    const accountId = await rl.question('  Account ID (from the dashboard URL or Workers overview): ');
    return {
      apiToken: token.trim(),
      accountId: accountId.trim() || undefined,
    };
  } finally {
    rl.close();
  }
}

export async function runDeploy(): Promise<void> {
  // 1. Load zooid.json (run init if missing)
  let config = loadServerConfig();

  if (!config) {
    printInfo('No zooid.json found', 'starting setup...');
    console.log('');
    await runInit();
    config = loadServerConfig();
  }

  if (!config) {
    printError('Failed to load zooid.json after init');
    process.exit(1);
  }

  // 2. Resolve server directory
  const serverDir = findServerDir();

  if (!fs.existsSync(path.join(serverDir, 'wrangler.toml'))) {
    printError(`Server directory not found at ${serverDir}`);
    console.log('Make sure you\'re running from the zooid monorepo.');
    process.exit(1);
  }

  // Derive unique names from server name
  const serverSlug = config.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const dbName = `zooid-db-${serverSlug}`;
  const workerName = `zooid-${serverSlug}`;

  // 3. Check wrangler available
  try {
    execSync('npx wrangler --version', { cwd: serverDir, stdio: 'pipe' });
  } catch {
    printError('wrangler not found. Install with: npm install -g wrangler');
    process.exit(1);
  }

  // 4. Get CF credentials
  const creds = await getCfCredentials();

  try {
    wrangler('whoami', serverDir, creds);
    printSuccess('Cloudflare authentication verified');
  } catch {
    printError('Invalid Cloudflare API token');
    process.exit(1);
  }

  // 5. Detect first deploy vs redeploy
  let isFirstDeploy = false;
  try {
    const output = wrangler('d1 list --json', serverDir, creds);
    const databases = JSON.parse(output) as Array<{ name: string }>;
    isFirstDeploy = !databases.some((db) => db.name === dbName);
  } catch {
    isFirstDeploy = true;
  }

  let adminToken: string | undefined;

  if (isFirstDeploy) {
    console.log('');
    printInfo('Deploy type', 'First deploy — setting up database and secrets');
    console.log('');

    // 6. Create D1 database
    console.log(`Creating D1 database (${dbName})...`);
    const d1Output = wrangler(`d1 create ${dbName}`, serverDir, creds);

    const dbIdMatch = d1Output.match(/database_id\s*=\s*"([^"]+)"/);
    if (!dbIdMatch) {
      printError('Failed to parse database ID from wrangler output');
      console.log(d1Output);
      process.exit(1);
    }

    const databaseId = dbIdMatch[1];
    printSuccess(`D1 database created (${databaseId})`);

    // Update wrangler.toml with real values
    const wranglerTomlPath = path.join(serverDir, 'wrangler.toml');
    let tomlContent = fs.readFileSync(wranglerTomlPath, 'utf-8');
    tomlContent = tomlContent.replace('name = "zooid"', `name = "${workerName}"`);
    tomlContent = tomlContent.replace('database_name = "zooid-db"', `database_name = "${dbName}"`);
    tomlContent = tomlContent.replace('database_id = "local"', `database_id = "${databaseId}"`);
    tomlContent = tomlContent.replace('ZOOID_SERVER_ID = "zooid-local"', `ZOOID_SERVER_ID = "${serverSlug}"`);
    fs.writeFileSync(wranglerTomlPath, tomlContent);
    printSuccess('Updated wrangler.toml');

    // 7. Run schema migration
    const schemaPath = path.join(serverDir, 'src/db/schema.sql');
    if (fs.existsSync(schemaPath)) {
      console.log('Running database schema migration...');
      wrangler(`d1 execute ${dbName} --remote --file=${schemaPath}`, serverDir, creds);
      printSuccess('Database schema initialized');
    }

    // 8. Generate secrets
    console.log('Generating secrets...');

    // JWT secret
    const jwtSecret = crypto.randomBytes(32).toString('base64');

    // Ed25519 key pair
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const privateKeyB64 = Buffer.from(privateKeyRaw).toString('base64');
    const publicKeyB64 = Buffer.from(publicKeyRaw).toString('base64');

    wrangler('secret put ZOOID_JWT_SECRET', serverDir, creds, { input: jwtSecret });
    printSuccess('Set ZOOID_JWT_SECRET');

    wrangler('secret put ZOOID_SIGNING_KEY', serverDir, creds, { input: privateKeyB64 });
    printSuccess('Set ZOOID_SIGNING_KEY (Ed25519 private)');

    wrangler('secret put ZOOID_PUBLIC_KEY', serverDir, creds, { input: publicKeyB64 });
    printSuccess('Set ZOOID_PUBLIC_KEY (Ed25519 public)');

    // 9. Generate admin token
    adminToken = await createAdminToken(jwtSecret);
    printSuccess('Admin token generated');
  } else {
    console.log('');
    printInfo('Deploy type', 'Redeploying existing server');
    console.log('');

    // Load existing admin token from config (resolve via canonicalUrl since zooid.json may have url)
    const existingConfig = loadConfig();
    adminToken = existingConfig.admin_token;

    if (!adminToken) {
      printError('No admin token found in ~/.zooid/config.json for this server');
      console.log('If this is a first deploy, remove the D1 database and try again.');
      process.exit(1);
    }
  }

  // 10. Deploy worker
  console.log('Deploying worker...');
  const deployOutput = wrangler('deploy', serverDir, creds);

  const { workerUrl, customDomain } = parseDeployUrls(deployOutput);
  printSuccess('Worker deployed');
  if (workerUrl) {
    printInfo('Worker URL', workerUrl);
  }
  if (customDomain) {
    printInfo('Custom domain', customDomain);
  }

  // Canonical URL: zooid.json url > custom domain > workers.dev
  const canonicalUrl = config.url || customDomain || workerUrl;

  // 11. Push server identity (wait for worker propagation)
  await new Promise((r) => setTimeout(r, 2000));
  if (canonicalUrl && adminToken) {
    try {
      const client = new ZooidClient({ server: canonicalUrl, token: adminToken });
      await client.updateServerMeta({
        name: config.name || undefined,
        description: config.description || undefined,
        tags: config.tags.length > 0 ? config.tags : undefined,
        owner: config.owner || undefined,
        company: config.company || undefined,
        email: config.email || undefined,
      });
      printSuccess('Server identity updated');
    } catch (err) {
      printError(`Failed to push server identity: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 12. Save config
  if (!config.url && (customDomain || workerUrl)) {
    config.url = customDomain || workerUrl!;
    saveServerConfig(config);
    printSuccess('Saved URL to zooid.json');
  }

  const configToSave: Parameters<typeof saveConfig>[0] = {
    worker_url: workerUrl || undefined,
    admin_token: adminToken,
  };
  if (isFirstDeploy) {
    configToSave.channels = {};
  }
  saveConfig(configToSave, canonicalUrl || undefined);
  printSuccess('Saved connection config to ~/.zooid/config.json');

  // 13. Print summary
  console.log('');
  console.log('  ──────────────────────────────────────');
  console.log('  🪸 Zooid server deployed!');
  console.log('  ──────────────────────────────────────');
  printInfo('Server', canonicalUrl || '(unknown)');
  if (workerUrl && workerUrl !== canonicalUrl) {
    printInfo('Worker URL', workerUrl);
  }
  printInfo('Name', config.name || '(not set)');
  if (isFirstDeploy) {
    printInfo('Admin token', adminToken!.slice(0, 20) + '...');
  }
  printInfo('Config', '~/.zooid/config.json');
  console.log('');
  if (isFirstDeploy) {
    console.log('  Next steps:');
    console.log('    npx zooid channel create my-channel');
    console.log('    npx zooid publish my-channel --data=\'{"hello": "world"}\'');
    console.log('');
  }
}
