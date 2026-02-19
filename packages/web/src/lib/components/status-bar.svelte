<script lang="ts">
  let {
    status,
    eventCount,
    pollInterval,
  }: {
    status: 'polling' | 'error' | 'idle' | 'loading';
    eventCount: number;
    pollInterval: number;
  } = $props();

  const statusText: Record<string, string> = {
    polling: 'Connected',
    error: 'Error',
    idle: 'Idle',
    loading: 'Loading...',
  };

  const statusColor: Record<string, string> = {
    polling: 'bg-primary',
    error: 'bg-destructive',
    idle: 'bg-muted-foreground',
    loading: 'bg-muted-foreground',
  };
</script>

<div class="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground border-t border-border">
  <div class="flex items-center gap-2">
    <span class={`inline-block w-1.5 h-1.5 rounded-full ${statusColor[status]}`}></span>
    <span>{statusText[status]}</span>
    {#if status === 'polling'}
      <span class="text-muted-foreground/60">poll every {pollInterval}s</span>
    {/if}
  </div>
  <span>{eventCount} event{eventCount === 1 ? '' : 's'}</span>
</div>
