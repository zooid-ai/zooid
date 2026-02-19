/**
 * Validate a channel ID slug.
 * Rules: lowercase alphanumeric + hyphens, 3-64 chars, no leading/trailing hyphens.
 */
export function isValidChannelId(id: string): boolean {
  if (id.length < 3 || id.length > 64) return false;
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id);
}
