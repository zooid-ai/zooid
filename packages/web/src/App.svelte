<script lang="ts">
  import Homepage from './lib/components/homepage.svelte';
  import ChannelHeader from './lib/components/channel-header.svelte';
  import EventFeed from './lib/components/event-feed.svelte';
  import StatusBar from './lib/components/status-bar.svelte';
  import TokenPrompt from './lib/components/token-prompt.svelte';
  import {
    fetchServerMeta,
    getChannel,
    pollEvents,
    type ChannelInfo,
    type ZooidEvent,
  } from './lib/api';

  const WS_POLL_THRESHOLD = 60; // seconds — above this, prefer polling over WS
  const RECONNECT_DELAYS = [0, 1000, 2000, 4000, 8000]; // backoff schedule (ms)

  // Parse route: /:channelId?token=...
  const path = window.location.pathname;
  const match = path.match(/^\/([a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/);
  const channelId = match?.[1] ?? null;

  const params = new URLSearchParams(window.location.search);
  let token = $state(params.get('token') ?? '');

  let channel = $state<ChannelInfo | null>(null);
  let events = $state<ZooidEvent[]>([]);
  let status = $state<'connected' | 'polling' | 'reconnecting' | 'error' | 'idle' | 'loading'>('loading');
  let needsAuth = $state(false);
  let cursor = $state<string | null>(null);
  let pollTimer = $state<ReturnType<typeof setInterval> | null>(null);
  let pollInterval = $state(5);
  let ws = $state<WebSocket | null>(null);
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Track known event IDs to avoid duplicates (WS + poll overlap)
  const seenIds = new Set<string>();

  // Base URL is the origin (same Worker serves API + static assets)
  const baseUrl = window.location.origin;

  function updateRssLink(chId: string, tok?: string) {
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

  function cleanup() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.close(); ws = null; }
    seenIds.clear();
  }

  async function loadChannel() {
    if (!channelId) return;

    cleanup();
    status = 'loading';
    const ch = await getChannel(baseUrl, channelId, token || undefined);

    if (!ch) {
      needsAuth = true;
      status = 'idle';
      return;
    }

    channel = ch;
    needsAuth = false;
    document.title = `${ch.name} — Zooid`;
    updateRssLink(channelId, token || undefined);

    // Fetch initial events via HTTP
    await fetchEvents();

    // Decide transport based on server metadata
    const meta = await fetchServerMeta(baseUrl);
    const supportsWs = meta.delivery.includes('websocket');

    if (supportsWs && meta.poll_interval <= WS_POLL_THRESHOLD) {
      connectWebSocket();
    } else {
      pollInterval = meta.poll_interval;
      startPolling();
    }
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
        // API returns events ASC (oldest first) — reverse to newest-first
        const newest = result.events.slice().reverse();
        const fresh = newest.filter((e) => !seenIds.has(e.id));
        for (const e of fresh) seenIds.add(e.id);

        if (cursor && fresh.length > 0) {
          events = [...fresh, ...events];
        } else if (!cursor) {
          events = fresh;
        }
        // Cursor = newest event ID (last in ASC response)
        cursor = result.events[result.events.length - 1]?.id ?? cursor;
      }
    } catch {
      status = 'error';
    }
  }

  // --- Polling ---

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    status = 'polling';
    pollTimer = setInterval(async () => {
      if (channelId) {
        const ch = await getChannel(baseUrl, channelId, token || undefined);
        if (ch) channel = ch;
      }
      await fetchEvents();
      status = 'polling';
    }, pollInterval * 1000);
  }

  // --- WebSocket ---

  function connectWebSocket() {
    if (!channelId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = new URL(`${protocol}//${window.location.host}/api/v1/channels/${channelId}/ws`);
    if (token) wsUrl.searchParams.set('token', token);

    const socket = new WebSocket(wsUrl.toString());

    socket.addEventListener('open', () => {
      status = 'connected';
      reconnectAttempt = 0;

      // Poll once on connect to fill any gap from missed events
      fetchEvents();
    });

    socket.addEventListener('message', (e) => {
      try {
        const event: ZooidEvent = JSON.parse(e.data);
        if (seenIds.has(event.id)) return;
        seenIds.add(event.id);
        events = [event, ...events];
        cursor = event.id;
      } catch {
        // Ignore malformed messages
      }
    });

    socket.addEventListener('close', () => {
      ws = null;
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' will fire after 'error', reconnect handled there
    });

    ws = socket;
  }

  function scheduleReconnect() {
    if (reconnectAttempt >= RECONNECT_DELAYS.length) {
      // Exhausted retries — fall back to polling
      pollInterval = pollInterval || 5;
      startPolling();
      return;
    }

    status = 'reconnecting';
    const delay = RECONNECT_DELAYS[reconnectAttempt];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function handleTokenConnect(newToken: string) {
    token = newToken;
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
  <div class="flex flex-col h-dvh max-w-2xl mx-auto">
    <ChannelHeader {channel} />
    <EventFeed {events} />
    <StatusBar {status} eventCount={events.length} {pollInterval} />
  </div>
{:else}
  <div class="flex items-center justify-center h-screen text-sm text-muted-foreground">
    Loading...
  </div>
{/if}
