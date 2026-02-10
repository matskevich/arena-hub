import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { initDb } from './db.js';
import { insertEvent, getEventsSince } from './db.js';
import { authenticate, checkRateLimit } from './auth.js';
import { validateEventBody } from './validate.js';
import { addSubscriber, broadcast, startHeartbeat, stopHeartbeat, disconnectAll } from './sse.js';

const PORT = parseInt(process.env.ARENA_HUB_PORT || '9800', 10);
const HOST = process.env.ARENA_HUB_HOST || '127.0.0.1';
const DB_PATH = process.env.ARENA_HUB_DB || './arena-hub.db';

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handlePostEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // auth
  const auth = authenticate(req.headers.authorization);
  if (!auth.ok) {
    jsonResponse(res, auth.status, { error: auth.error });
    return;
  }

  // rate limit
  const rateCheck = checkRateLimit(auth.token);
  if (!rateCheck.ok) {
    res.setHeader('Retry-After', String(rateCheck.retryAfter));
    jsonResponse(res, 429, { error: rateCheck.error });
    return;
  }

  // read + validate body
  let raw: Buffer;
  try {
    raw = await readBody(req, 32 * 1024);
  } catch {
    jsonResponse(res, 413, { error: 'payload exceeds 32KB limit' });
    return;
  }

  const validation = validateEventBody(raw);
  if (!validation.ok) {
    jsonResponse(res, validation.status, { error: validation.error });
    return;
  }

  const { body } = validation;
  const payloadStr = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload);

  // insert + broadcast
  const event = insertEvent(body.room, auth.token.name, body.kind, payloadStr, auth.token.id);
  broadcast(event);
  jsonResponse(res, 201, event);
}

function handleGetStream(req: IncomingMessage, res: ServerResponse): void {
  // auth
  const auth = authenticate(req.headers.authorization);
  if (!auth.ok) {
    jsonResponse(res, auth.status, { error: auth.error });
    return;
  }

  // parse query
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sinceParam = url.searchParams.get('since');
  const roomsParam = url.searchParams.get('rooms');
  const since = sinceParam ? parseInt(sinceParam, 10) : 0;
  const rooms = roomsParam ? roomsParam.split(',').filter(Boolean) : null;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // replay events since ID
  if (sinceParam !== null) {
    const events = getEventsSince(since, rooms ?? undefined);
    for (const event of events) {
      res.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  // register subscriber
  addSubscriber(res, auth.token.id, rooms);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/events') {
    handlePostEvents(req, res).catch((err) => {
      console.error('POST /events error:', err);
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'internal server error' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stream') {
    handleGetStream(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    jsonResponse(res, 200, { ok: true, subscribers: 0 });
    return;
  }

  jsonResponse(res, 404, { error: 'not found' });
}

// --- Main ---

export function startServer(dbPath?: string, port?: number, host?: string): { server: ReturnType<typeof createServer>; db: ReturnType<typeof initDb> } {
  const db = initDb(dbPath ?? DB_PATH);
  const server = createServer(handleRequest);
  const actualPort = port ?? PORT;
  const actualHost = host ?? HOST;

  startHeartbeat();

  server.listen(actualPort, actualHost, () => {
    console.log(`arena-hub listening on ${actualHost}:${actualPort}`);
  });

  const shutdown = () => {
    console.log('shutting down...');
    stopHeartbeat();
    disconnectAll();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // force exit after 5s
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, db };
}

// run if executed directly
const isMain = process.argv[1]?.endsWith('server.js');
if (isMain) {
  startServer();
}
