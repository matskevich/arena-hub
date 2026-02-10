import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../src/server.js';
import { insertToken } from '../src/db.js';
import { hashToken, clearRateLimits } from '../src/auth.js';
import { stopHeartbeat, disconnectAll } from '../src/sse.js';

let server: http.Server;
let db: { close(): void };
let token: string;
const PORT = 19800 + Math.floor(Math.random() * 1000);

function postEvent(room: string, kind: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ room, kind, payload });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, method: 'POST', path: '/events',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('sse', () => {
  before(async () => {
    const result = startServer(':memory:', PORT, '127.0.0.1');
    server = result.server;
    db = result.db;

    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on('listening', resolve);
    });

    token = 'test-sse-token-' + Date.now();
    insertToken('sse-bot', hashToken(token), '*', 100, 10000, null);
  });

  after(async () => {
    stopHeartbeat();
    disconnectAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('subscribe + publish → receives event via SSE', async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE timeout')), 5000);

      const req = http.request({
        hostname: '127.0.0.1', port: PORT, method: 'GET',
        path: '/stream?rooms=sse-test',
        headers: { 'Authorization': `Bearer ${token}` },
      }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');

        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          if (text.includes('"room":"sse-test"')) {
            clearTimeout(timeout);
            req.destroy();
            resolve(text);
          }
        });
      });

      req.on('error', () => {}); // ignore destroy errors
      req.end();

      // publish after a short delay
      setTimeout(() => {
        postEvent('sse-test', 'message', { text: 'hello sse' });
      }, 200);
    });

    assert.ok(received.includes('sse-test'));
    assert.ok(received.includes('hello sse'));
  });

  it('since= replays past events', async () => {
    // publish some events first
    await postEvent('replay-test', 'msg', { n: 1 });
    await postEvent('replay-test', 'msg', { n: 2 });
    const last = JSON.parse((await postEvent('replay-test', 'msg', { n: 3 })).body);

    // subscribe with since=0 to get all events
    const received = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('replay timeout')), 3000);
      let buffer = '';

      const req = http.request({
        hostname: '127.0.0.1', port: PORT, method: 'GET',
        path: '/stream?rooms=replay-test&since=0',
        headers: { 'Authorization': `Bearer ${token}` },
      }, (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          // wait until we see the last event
          if (buffer.includes(`"id":${last.id}`)) {
            clearTimeout(timeout);
            req.destroy();
            resolve(buffer);
          }
        });
      });

      req.on('error', () => {});
      req.end();
    });

    // should contain all 3 events (payload is JSON-stringified, so escaped)
    const events = received.split('\n\n').filter(block => block.includes('data:'));
    const replayEvents = events.filter(e => e.includes('replay-test'));
    assert.ok(replayEvents.length >= 3, `expected >= 3 replay events, got ${replayEvents.length}`);
  });

  it('returns 401 for SSE without auth', async () => {
    const result = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: PORT, method: 'GET',
        path: '/stream',
      }, (res) => {
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on('error', () => {});
      req.end();
    });

    assert.equal(result, 401);
  });
});
