import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../src/server.js';
import { insertToken } from '../src/db.js';
import { hashToken } from '../src/auth.js';
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

describe('artifacts', () => {
  before(async () => {
    const result = startServer(':memory:', PORT, '127.0.0.1');
    server = result.server;
    db = result.db;

    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on('listening', resolve);
    });

    token = 'test-artifact-token-' + Date.now();
    insertToken('test-bot', hashToken(token), '*', 10, 1000, null);
  });

  after(async () => {
    stopHeartbeat();
    disconnectAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('POST /artifacts creates artifact and returns 201', async () => {
    const res = await request('POST', '/artifacts', {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      type: 'transcript',
      title: 'Test Video Transcript',
      content: 'This is the full transcript content...',
      metadata: { url: 'https://youtube.com/test', words: 500 },
    }));

    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.type, 'transcript');
    assert.equal(body.title, 'Test Video Transcript');
    assert.equal(body.author, 'test-bot');
    assert.ok(body.id);
  });

  it('GET /artifacts/:id returns artifact', async () => {
    // create first
    const createRes = await request('POST', '/artifacts', {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      type: 'digest',
      title: 'Test Digest',
      content: '1. Key point one\n2. Key point two',
    }));
    const created = JSON.parse(createRes.body);

    // fetch
    const res = await request('GET', `/artifacts/${created.id}`, {
      'Authorization': `Bearer ${token}`,
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, created.id);
    assert.equal(body.content, '1. Key point one\n2. Key point two');
  });

  it('GET /artifacts lists artifacts', async () => {
    const res = await request('GET', '/artifacts', {
      'Authorization': `Bearer ${token}`,
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.artifacts));
    assert.ok(body.artifacts.length >= 2);
  });

  it('GET /artifacts?type=digest filters by type', async () => {
    const res = await request('GET', '/artifacts?type=digest', {
      'Authorization': `Bearer ${token}`,
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.every((a: { type: string }) => a.type === 'digest'));
  });

  it('GET /artifacts/:id returns 404 for missing artifact', async () => {
    const res = await request('GET', '/artifacts/99999', {
      'Authorization': `Bearer ${token}`,
    });
    assert.equal(res.status, 404);
  });

  it('POST /artifacts returns 401 without auth', async () => {
    const res = await request('POST', '/artifacts', {
      'Content-Type': 'application/json',
    }, JSON.stringify({ type: 'test', title: 'test', content: 'test' }));
    assert.equal(res.status, 401);
  });

  it('POST /artifacts returns 400 for missing fields', async () => {
    const res = await request('POST', '/artifacts', {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ type: 'test' }));
    assert.equal(res.status, 400);
  });

  it('list excludes content field for efficiency', async () => {
    const res = await request('GET', '/artifacts', {
      'Authorization': `Bearer ${token}`,
    });
    const body = JSON.parse(res.body);
    // list should NOT include content (it can be large)
    assert.equal(body.artifacts[0].content, undefined);
  });
});
