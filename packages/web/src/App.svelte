<script lang="ts">
  import Homepage from './lib/components/homepage.svelte';
  import ChannelHeader from './lib/components/channel-header.svelte';
  import EventFeed from './lib/components/event-feed.svelte';
  import StatusBar from './lib/components/status-bar.svelte';
  import TokenPrompt from './lib/components/token-prompt.svelte';
  import {
    getChannel,
    pollEvents,
    type ChannelInfo,
    type ZooidEvent,
  } from './lib/api';

  const POLL_INTERVAL = 5;

  // Parse route: /:channelId?token=...
  const path = window.location.pathname;
  const match = path.match(/^\/([a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/);
  const channelId = match?.[1] ?? null;

  const params = new URLSearchParams(window.location.search);
  let token = $state(params.get('token') ?? '');

  let channel = $state<ChannelInfo | null>(null);
  let events = $state<ZooidEvent[]>([]);
  let status = $state<'polling' | 'error' | 'idle' | 'loading'>('loading');
  let needsAuth = $state(false);
  let cursor = $state<string | null>(null);
  let pollTimer = $state<ReturnType<typeof setInterval> | null>(null);

  // Base URL is the origin (same Worker serves API + static assets)
  const baseUrl = window.location.origin;

  function updateRssLink(chId: string, tok?: string) {
    // Add RSS discovery link
    let link = document.querySelector('link[rel="alternate"][type="application/rss+xml"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'alternate';
      link.type = 'application/rss+xml';
      document.head.appendChild(link);
    }
    const rssUrl = tok
      ? `${baseUrl}/api/v1/channels/${chId}/rss?token=${tok}`
      : `${baseUrl}/api/v1/channels/${chId}/rss`;
    link.href = rssUrl;
    link.title = `${chId} RSS Feed`;
  }

  async function loadChannel() {
    if (!channelId) return;

    status = 'loading';
    const ch = await getChannel(baseUrl, channelId, token || undefined);

    if (!ch) {
      // Might be private and need auth, or not found
      needsAuth = true;
      status = 'idle';
      return;
    }

    channel = ch;
    needsAuth = false;
    document.title = `${ch.name} — Zooid`;
    updateRssLink(channelId, token || undefined);

    await fetchEvents();
    startPolling();
  }

  async function fetchEvents() {
    if (!channelId) return;

    try {
      const result = await pollEvents(baseUrl, channelId, {
        cursor: cursor ?? undefined,
        token: token || undefined,
        limit: 50,
      });

      if (result.events.length > 0) {
        if (cursor) {
          // Append new events at the top (newest first)
          events = [...result.events, ...events];
        } else {
          events = result.events;
        }
        // Update cursor to latest event for next poll
        cursor = result.events[0]?.id ?? cursor;
      }

      status = 'polling';
    } catch {
      status = 'error';
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      // Refresh channel info
      if (channelId) {
        const ch = await getChannel(baseUrl, channelId, token || undefined);
        if (ch) channel = ch;
      }
      await fetchEvents();
    }, POLL_INTERVAL * 1000);
  }

  function handleTokenConnect(newToken: string) {
    token = newToken;
    // Update URL without reload
    const url = new URL(window.location.href);
    url.searchParams.set('token', newToken);
    window.history.replaceState({}, '', url.toString());
    loadChannel();
  }

  // Initial load
  if (channelId) {
    loadChannel();
  }
</script>

{#if !channelId}
  <Homepage />
{:else if needsAuth && !channel}
  <TokenPrompt onConnect={handleTokenConnect} />
{:else if channel}
  <div class="flex flex-col h-screen max-w-2xl mx-auto">
    <ChannelHeader {channel} />
    <EventFeed {events} />
    <StatusBar {status} eventCount={events.length} pollInterval={POLL_INTERVAL} />
  </div>
{:else}
  <div class="flex items-center justify-center h-screen text-sm text-muted-foreground">
    Loading...
  </div>
{/if}
