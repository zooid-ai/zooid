import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../lib/config';
import { printSuccess, printInfo } from '../lib/output';

function findServerDir(): string {
  // In monorepo: dist/index.js → ../server
  // Resolve from the CLI package root, not from dist/
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(cliDir, '../../server');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

async function createAdminToken(secret: string): Promise<string> {
  const header = base64url(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  );
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        scope: 'admin',
        iat: Math.floor(Date.now() / 1000),
      }),
    ),
  );

  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data),
  );
  const signature = base64url(Buffer.from(sig));

  return `${data}.${signature}`;
}

export async function runDev(port = 8787): Promise<void> {
  const serverDir = findServerDir();

  if (!fs.existsSync(path.join(serverDir, 'wrangler.toml'))) {
    throw new Error(
      `Server directory not found at ${serverDir}. ` +
        "Make sure you're running from the zooid monorepo.",
    );
  }

  // Generate a JWT secret for local dev
  const jwtSecret = crypto.randomUUID();

  // Write .dev.vars (wrangler reads this for local secrets)
  const devVarsPath = path.join(serverDir, '.dev.vars');
  fs.writeFileSync(devVarsPath, `ZOOID_JWT_SECRET=${jwtSecret}\n`);

  // Create admin token and save config
  const adminToken = await createAdminToken(jwtSecret);
  const serverUrl = `http://localhost:${port}`;

  saveConfig({ admin_token: adminToken }, serverUrl);

  // Initialize D1 schema
  const schemaPath = path.join(serverDir, 'src/db/schema.sql');
  if (fs.existsSync(schemaPath)) {
    try {
      execSync(
        `npx wrangler d1 execute zooid-db --local --file=${schemaPath}`,
        {
          cwd: serverDir,
          stdio: 'pipe',
        },
      );
      printSuccess('Database schema initialized');
    } catch {
      // Tables may already exist — that's fine
      printSuccess('Database ready (schema already exists)');
    }
  }

  printSuccess('Local server configured');
  printInfo('Server', serverUrl);
  printInfo('Admin token', adminToken.slice(0, 20) + '...');
  printInfo('Config saved to', '~/.zooid/config.json');
  console.log('');
  console.log('Starting wrangler dev...');
  console.log('');

  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(port)],
    {
      cwd: serverDir,
      stdio: 'inherit',
      shell: true,
    },
  );

  child.on('error', (err) => {
    console.error(`Failed to start local server: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
