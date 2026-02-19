<script lang="ts">
  import { Badge } from '@ui/components/badge/index';
  import { Card, CardContent } from '@ui/components/card/index';
  import { Separator } from '@ui/components/separator/index';
  import { fetchServerMeta, listChannels, type ChannelInfo } from '../api';

  const baseUrl = window.location.origin;

  let serverName = $state('Zooid');
  let serverDesc = $state<string | null>(null);
  let channels = $state<ChannelInfo[]>([]);
  let loading = $state(true);

  async function load() {
    const [meta, chs] = await Promise.all([
      fetchServerMeta(baseUrl),
      listChannels(baseUrl),
    ]);
    serverName = meta.server_name;
    serverDesc = meta.server_description;
    channels = chs;
    loading = false;
  }

  load();

  function formatRelative(iso: string): string {
    const hasOffset = /Z|[+-]\d{2}:?\d{2}$/.test(iso);
    const ts = hasOffset ? iso : iso + 'Z';
    const diff = Date.now() - new Date(ts).getTime();
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

<div class="min-h-screen max-w-2xl mx-auto px-4 py-12 flex flex-col">
  <header class="mb-10">
    <h1 class="text-2xl font-bold tracking-tight mb-1">{serverName}</h1>
    <p class="text-sm text-muted-foreground">{serverDesc ?? 'Channels on this server:'}</p>
  </header>

  {#if loading}
    <p class="text-sm text-muted-foreground">Loading channels...</p>
  {:else if channels.length === 0}
    <div class="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-8 text-center">
      <p>No channels yet.</p>
      <p class="mt-1">Create one with <code class="text-foreground">npx zooid channel create</code></p>
    </div>
  {:else}
    <div class="flex flex-col gap-3">
      {#each channels as ch (ch.id)}
        <a href="/{ch.id}" class="block group no-underline">
          <Card class="transition-colors group-hover:border-primary/40">
            <CardContent class="p-4">
              <div class="flex items-center justify-between gap-2 mb-1">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-sm">{ch.name}</span>
                  {#if ch.is_public}
                    <Badge variant="secondary" class="text-[10px] px-1.5 py-0">public</Badge>
                  {:else}
                    <Badge variant="outline" class="text-[10px] px-1.5 py-0">private</Badge>
                  {/if}
                </div>
                <span class="text-[10px] text-muted-foreground shrink-0">
                  {ch.event_count} event{ch.event_count === 1 ? '' : 's'}
                </span>
              </div>

              {#if ch.description}
                <p class="text-xs text-muted-foreground mb-2">{ch.description}</p>
              {/if}

              <div class="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                <span class="font-mono">{ch.id}</span>
                {#if ch.last_event_at}
                  <Separator orientation="vertical" class="h-3" />
                  <span>latest {formatRelative(ch.last_event_at)}</span>
                {/if}
                {#if ch.publishers.length > 0}
                  <Separator orientation="vertical" class="h-3" />
                  <span>{ch.publishers.length} publisher{ch.publishers.length === 1 ? '' : 's'}</span>
                {/if}
              </div>
            </CardContent>
          </Card>
        </a>
      {/each}
    </div>
  {/if}

  <div class="flex-1"></div>
  <footer class="mt-12 pt-4 pb-[env(safe-area-inset-bottom)] border-t border-border text-[10px] text-muted-foreground/40 flex items-center justify-between">
    <span>Powered by <a href="https://zooid.dev" class="underline hover:text-muted-foreground">Zooid</a></span>
    <a href="https://github.com/zooid-ai/zooid" class="underline hover:text-muted-foreground">Star us on GitHub</a>
  </footer>
</div>
