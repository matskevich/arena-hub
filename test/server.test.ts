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

function request(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode!,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('server', () => {
  before(async () => {
    const result = startServer(':memory:', PORT, '127.0.0.1');
    server = result.server;
    db = result.db;

    // wait for server to start
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on('listening', resolve);
    });

    // create a test token
    token = 'test-server-token-' + Date.now();
    insertToken('test-bot', hashToken(token), '*', 10, 1000, null);
  });

  after(async () => {
    stopHeartbeat();
    disconnectAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('POST /events returns 201', async () => {
    const res = await request('POST', '/events', {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ room: 'test', kind: 'message', payload: { text: 'hello' } }));

    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.room, 'test');
    assert.equal(body.kind, 'message');
    assert.equal(body.author, 'test-bot');
  });

  it('POST /events returns 401 without auth', async () => {
    const res = await request('POST', '/events', {
      'Content-Type': 'application/json',
    }, JSON.stringify({ room: 'test', kind: 'message', payload: {} }));

    assert.equal(res.status, 401);
  });

  it('POST /events returns 400 for invalid body', async () => {
    const res = await request('POST', '/events', {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ kind: 'message', payload: {} }));

    assert.equal(res.status, 400);
  });

  it('POST /events returns 429 when rate limited', async () => {
    clearRateLimits();

    // create token with burst=2
    const limitedToken = 'limited-token-' + Date.now();
    insertToken('limited-bot', hashToken(limitedToken), '*', 2, 1000, null);

    // exhaust burst
    for (let i = 0; i < 2; i++) {
      await request('POST', '/events', {
        'Authorization': `Bearer ${limitedToken}`,
        'Content-Type': 'application/json',
      }, JSON.stringify({ room: 'test', kind: 'ping', payload: {} }));
    }

    const res = await request('POST', '/events', {
      'Authorization': `Bearer ${limitedToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ room: 'test', kind: 'ping', payload: {} }));

    assert.equal(res.status, 429);
  });

  it('GET /health returns 200', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
  });

  it('GET /unknown returns 404', async () => {
    const res = await request('GET', '/unknown');
    assert.equal(res.status, 404);
  });
});
