import { DurableObject } from 'cloudflare:workers';
import type { Bindings } from '../types';

const TAG_ALL = 'type:*';
const TAG_PREFIX = 'type:';

export class ChannelDO extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const typesParam = url.searchParams.get('types');

    const tags: string[] = [];
    if (typesParam) {
      for (const t of typesParam.split(',')) {
        const trimmed = t.trim();
        if (trimmed) tags.push(TAG_PREFIX + trimmed);
      }
    }
    // No types specified → receive all events
    if (tags.length === 0) tags.push(TAG_ALL);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tags);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async broadcast(event: Record<string, unknown>): Promise<void> {
    const message = JSON.stringify(event);
    const eventType = typeof event.type === 'string' ? event.type : null;

    // Collect sockets that should receive this event
    const targets = new Set<WebSocket>();

    // Unfiltered sockets always receive
    for (const ws of this.ctx.getWebSockets(TAG_ALL)) {
      targets.add(ws);
    }

    // If the event has a type, also include sockets subscribed to that type
    if (eventType) {
      for (const ws of this.ctx.getWebSockets(TAG_PREFIX + eventType)) {
        targets.add(ws);
      }
    }

    for (const ws of targets) {
      try {
        ws.send(message);
      } catch {
        // Client disconnected — close silently
        try {
          ws.close(1011, 'Broadcast failed');
        } catch {
          // Already closed
        }
      }
    }
  }

  webSocketMessage() {}
  webSocketClose() {}
  webSocketError() {}
}
