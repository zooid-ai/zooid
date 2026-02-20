import { loadDirectoryToken, saveDirectoryToken } from './config';
import { printInfo, printError } from './output';

const DIRECTORY_BASE_URL = 'https://directory.zooid.dev';
const TOKEN_PREFIX = 'zd_';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export { DIRECTORY_BASE_URL };

/** Load the directory token if it exists and looks valid. */
export function getDirectoryToken(): string | undefined {
  const token = loadDirectoryToken();
  if (token && token.startsWith(TOKEN_PREFIX)) {
    return token;
  }
  return undefined;
}

/** Return a valid directory token, triggering device auth if needed. */
export async function ensureDirectoryToken(): Promise<string> {
  const existing = getDirectoryToken();
  if (existing) return existing;
  return deviceAuth();
}

interface DeviceAuthResponse {
  device_code: string;
  verification_url: string;
  expires_in: number;
}

interface DeviceStatusResponse {
  status: 'pending' | 'complete' | 'expired';
  token?: string;
}

/** Run the GitHub device auth flow against the directory service. */
async function deviceAuth(): Promise<string> {
  // Step 1: Request a device code
  const res = await fetch(`${DIRECTORY_BASE_URL}/api/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Directory auth failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as DeviceAuthResponse;
  const { device_code, verification_url } = data;

  // Step 2: Open the browser
  console.log('');
  printInfo('Authorize', verification_url);
  console.log('  Opening browser to complete GitHub sign-in...\n');

  try {
    const { exec } = await import('node:child_process');
    const platform = process.platform;
    const cmd =
      platform === 'darwin'
        ? 'open'
        : platform === 'win32'
          ? 'start'
          : 'xdg-open';
    exec(`${cmd} "${verification_url}"`);
  } catch {
    console.log(
      '  Could not open browser automatically. Please visit the URL above.\n',
    );
  }

  // Step 3: Poll for completion
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const statusRes = await fetch(
      `${DIRECTORY_BASE_URL}/api/auth/status?code=${encodeURIComponent(device_code)}`,
    );

    if (!statusRes.ok) continue;

    const status = (await statusRes.json()) as DeviceStatusResponse;

    if (status.status === 'complete' && status.token) {
      saveDirectoryToken(status.token);
      console.log('  Authenticated with Zooid Directory.\n');
      return status.token;
    }

    if (status.status === 'expired') {
      throw new Error('Device authorization expired. Please try again.');
    }
  }

  throw new Error(
    'Authorization timed out. You need your human to authorize you. Run `npx zooid share` again to retry.',
  );
}

/** Fetch wrapper that adds the directory token and retriggers auth on 401. */
export async function directoryFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  let token = await ensureDirectoryToken();

  const doFetch = (t: string) => {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${t}`);
    headers.set('Content-Type', 'application/json');
    return fetch(`${DIRECTORY_BASE_URL}${path}`, { ...options, headers });
  };

  let res = await doFetch(token);

  if (res.status === 401) {
    // Token may have expired — re-auth
    console.log('  Directory token expired. Re-authenticating...\n');
    token = await deviceAuth();
    res = await doFetch(token);
  }

  return res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
