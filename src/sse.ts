import { ServerResponse } from 'node:http';
import { Event } from './types.js';

interface Subscriber {
  res: ServerResponse;
  tokenId: number;
  rooms: Set<string> | null; // null = all rooms
}

const subscribers = new Set<Subscriber>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export function addSubscriber(res: ServerResponse, tokenId: number, rooms: string[] | null): void {
  const sub: Subscriber = {
    res,
    tokenId,
    rooms: rooms ? new Set(rooms) : null,
  };
  subscribers.add(sub);

  res.on('close', () => {
    subscribers.delete(sub);
  });
}

export function broadcast(event: Event): void {
  const data = JSON.stringify(event);
  for (const sub of subscribers) {
    if (sub.rooms && !sub.rooms.has(event.room)) continue;
    try {
      sub.res.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${data}\n\n`);
    } catch {
      subscribers.delete(sub);
    }
  }
}

export function disconnectByTokenId(tokenId: number): number {
  let count = 0;
  for (const sub of subscribers) {
    if (sub.tokenId === tokenId) {
      try {
        sub.res.end();
      } catch { /* ignore */ }
      subscribers.delete(sub);
      count++;
    }
  }
  return count;
}

export function startHeartbeat(intervalMs = 30_000): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    for (const sub of subscribers) {
      try {
        sub.res.write(': heartbeat\n\n');
      } catch {
        subscribers.delete(sub);
      }
    }
  }, intervalMs);
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getSubscriberCount(): number {
  return subscribers.size;
}

export function disconnectAll(): void {
  for (const sub of subscribers) {
    try { sub.res.end(); } catch { /* ignore */ }
  }
  subscribers.clear();
}
