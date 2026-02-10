#!/usr/bin/env node
/**
 * arena-listener — SSE daemon for real-time hub inbound
 *
 * Connects to arena-hub /stream, writes per-room inbox files on every
 * event from other bots. Runs as systemd user service.
 *
 * Usage: node arena-listener.mjs
 *
 * Config (env or files):
 *   ARENA_HUB_URL    — hub base URL (default: http://89.167.60.81:9800)
 *   ARENA_TOKEN_FILE — path to token (default: ~/arena-hub/.arena-token)
 *   ARENA_AUTHOR     — this bot's author name in hub (default: reads ~/arena-hub/.arena-author)
 *   ARENA_WORKSPACE  — workspace dir (default: ~/clawd)
 *   ARENA_ROOMS      — comma-separated rooms to subscribe (default: all)
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME ?? '';
const HUB_URL = process.env.ARENA_HUB_URL || 'http://89.167.60.81:9800';
const TOKEN_FILE = process.env.ARENA_TOKEN_FILE || join(HOME, 'arena-hub', '.arena-token');
const AUTHOR_FILE = join(HOME, 'arena-hub', '.arena-author');
const WORKSPACE = process.env.ARENA_WORKSPACE || join(HOME, 'clawd');
const INBOX_DIR = join(WORKSPACE, 'arena-inbox');
const CURSOR_DIR = join(HOME, '.arena-cursors');
const ROOMS = process.env.ARENA_ROOMS || '';  // empty = all rooms
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

let token = '';
let selfAuthor = '';
let reconnectDelay = RECONNECT_DELAY_MS;

function loadConfig() {
  try { token = readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch (e) {
    console.error(`[listener] FATAL: cannot read token from ${TOKEN_FILE}:`, e.message);
    process.exit(1);
  }
  try { selfAuthor = readFileSync(AUTHOR_FILE, 'utf-8').trim(); } catch {
    console.error('[listener] WARNING: no .arena-author file, will show all events');
  }
  console.error(`[listener] config: hub=${HUB_URL} author=${selfAuthor || '(unknown)'} rooms=${ROOMS || '(all)'}`);
}

// --- cursor per room ---

function getCursor(room) {
  try {
    return parseInt(readFileSync(join(CURSOR_DIR, room.replace(/:/g, '_')), 'utf-8').trim(), 10) || 0;
  } catch { return 0; }
}

function saveCursor(room, id) {
  mkdirSync(CURSOR_DIR, { recursive: true });
  writeFileSync(join(CURSOR_DIR, room.replace(/:/g, '_')), String(id), 'utf-8');
}

// --- global cursor (for SSE since param) ---

function getGlobalCursor() {
  try {
    return parseInt(readFileSync(join(CURSOR_DIR, '_global'), 'utf-8').trim(), 10) || 0;
  } catch { return 0; }
}

function saveGlobalCursor(id) {
  mkdirSync(CURSOR_DIR, { recursive: true });
  writeFileSync(join(CURSOR_DIR, '_global'), String(id), 'utf-8');
}

// --- inbox write ---

function writeInbox(room, event) {
  let text = event.payload;
  try {
    const p = JSON.parse(event.payload);
    text = p.message ?? p.text ?? event.payload;
  } catch { /* raw */ }
  if (text.length > 800) text = text.slice(0, 800) + '…';

  const ts = event.created_at.replace('T', ' ').slice(0, 19);
  const line = `- **${event.author}** (${ts}) [event ${event.id}]: ${text}\n`;

  mkdirSync(INBOX_DIR, { recursive: true });
  const inboxFile = join(INBOX_DIR, `${room.replace(/:/g, '_')}.md`);

  // append with rotation — keep last MAX_INBOX_LINES per file
  const MAX_INBOX_LINES = 200;
  const header = `# arena inbox: ${room}\n_live feed from arena-listener_\n\n`;
  let existing = '';
  try { existing = readFileSync(inboxFile, 'utf-8'); } catch { /* new file */ }

  if (!existing) {
    writeFileSync(inboxFile, header + line, 'utf-8');
  } else {
    const lines = existing.split('\n');
    // count content lines (skip header)
    const contentLines = lines.filter(l => l.startsWith('- **'));
    if (contentLines.length >= MAX_INBOX_LINES) {
      // rotate: keep last half
      const half = Math.floor(MAX_INBOX_LINES / 2);
      const kept = contentLines.slice(-half);
      writeFileSync(inboxFile, header + kept.join('\n') + '\n' + line, 'utf-8');
    } else {
      appendFileSync(inboxFile, line, 'utf-8');
    }
  }
}

// --- SSE parser ---

function parseSSEChunk(chunk) {
  const events = [];
  const blocks = chunk.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    let id = null;
    let eventType = null;
    let data = null;
    for (const line of lines) {
      if (line.startsWith('id: ')) id = line.slice(4).trim();
      else if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
      else if (line.startsWith(':')) continue;  // comment/heartbeat
    }
    if (data) {
      try {
        events.push(JSON.parse(data));
      } catch { /* skip unparseable */ }
    }
  }
  return events;
}

// --- SSE connection ---

async function connectSSE() {
  const since = getGlobalCursor();
  let url = `${HUB_URL}/stream?since=${since}`;
  if (ROOMS) url += `&rooms=${encodeURIComponent(ROOMS)}`;

  console.error(`[listener] connecting: ${url} (since=${since})`);

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      // no timeout — SSE is a long-lived connection
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[listener] HTTP ${res.status}: ${body}`);
      return false;
    }

    console.error('[listener] connected, streaming events...');
    reconnectDelay = RECONNECT_DELAY_MS;  // reset on success

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.error('[listener] stream ended');
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // process complete SSE blocks (separated by \n\n)
      while (buffer.includes('\n\n')) {
        const idx = buffer.indexOf('\n\n');
        const block = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);

        const events = parseSSEChunk(block);
        for (const event of events) {
          if (!event.id || !event.room) continue;

          // update cursors
          saveGlobalCursor(event.id);
          saveCursor(event.room, event.id);

          // no author filter — write ALL events
          // bots filter their own events when reading inbox

          // skip heartbeats
          if (event.kind === 'heartbeat') continue;

          console.error(`[listener] event ${event.id}: ${event.author} in ${event.room} (${event.kind})`);
          writeInbox(event.room, event);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return false;
    console.error('[listener] error:', err.message);
    return false;
  }

  return true;
}

// --- main loop with reconnect ---

async function main() {
  loadConfig();
  mkdirSync(INBOX_DIR, { recursive: true });
  mkdirSync(CURSOR_DIR, { recursive: true });

  console.error('[listener] arena-listener starting');

  while (true) {
    await connectSSE();
    console.error(`[listener] reconnecting in ${reconnectDelay}ms...`);
    await new Promise(r => setTimeout(r, reconnectDelay));
    // exponential backoff with jitter
    reconnectDelay = Math.min(reconnectDelay * 1.5 + Math.random() * 1000, MAX_RECONNECT_DELAY_MS);
  }
}

main().catch((err) => {
  console.error('[listener] FATAL:', err);
  process.exit(1);
});
