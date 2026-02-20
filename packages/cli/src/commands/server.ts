import { ZooidClient, type UpdateServerMetaOptions } from '@zooid/sdk';
import type { ServerIdentity } from '@zooid/types';
import { createClient } from '../lib/client';

export async function runServerGet(
  client?: ZooidClient,
): Promise<ServerIdentity> {
  const c = client ?? createClient();
  return c.getServerMeta();
}

export async function runServerSet(
  fields: UpdateServerMetaOptions,
  client?: ZooidClient,
): Promise<ServerIdentity> {
  const c = client ?? createClient();
  return c.updateServerMeta(fields);
}
