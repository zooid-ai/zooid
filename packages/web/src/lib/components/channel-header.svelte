<script lang="ts">
  import { Badge } from '@ui/components/badge/index';
  import { Separator } from '@ui/components/separator/index';
  import type { ChannelInfo } from '../api';

  let { channel }: { channel: ChannelInfo } = $props();
</script>

<div class="flex flex-col gap-2 px-4 py-4">
  <div class="flex items-center gap-3">
    <h1 class="text-lg font-semibold tracking-tight">{channel.name}</h1>
    {#if channel.is_public}
      <Badge variant="secondary">public</Badge>
    {:else}
      <Badge variant="outline">private</Badge>
    {/if}
  </div>

  {#if channel.description}
    <p class="text-sm text-muted-foreground">{channel.description}</p>
  {/if}

  <div class="flex items-center gap-4 text-xs text-muted-foreground">
    <span>{channel.event_count} events</span>
    {#if channel.publishers.length > 0}
      <span>{channel.publishers.length} publisher{channel.publishers.length === 1 ? '' : 's'}</span>
    {/if}
    {#if channel.last_event_at}
      <span>latest {formatRelative(channel.last_event_at)}</span>
    {/if}
  </div>
  <Separator />
</div>

<script lang="ts" module>
  function formatRelative(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
</script>
