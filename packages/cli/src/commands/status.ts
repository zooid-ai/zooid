import { ZooidClient } from '@zooid/sdk';
import type { ServerDiscovery, ServerIdentity } from '@zooid/types';
import { createClient } from '../lib/client';

export interface StatusResult {
  discovery: ServerDiscovery;
  identity: ServerIdentity;
}

export async function runStatus(client?: ZooidClient): Promise<StatusResult> {
  const c = client ?? createClient();
  const [discovery, identity] = await Promise.all([
    c.getMetadata(),
    c.getServerMeta(),
  ]);
  return { discovery, identity };
}
