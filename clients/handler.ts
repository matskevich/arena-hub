import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

type MessageEvent = {
  type: "message";
  action: "received" | "sent";
  sessionKey: string;
  context: Record<string, unknown>;
};

type HubEvent = {
  id: number;
  room: string;
  author: string;
  kind: string;
  payload: string;
  created_at: string;
};

const HOME = process.env.HOME ?? "";
const HUB_URL = process.env.ARENA_HUB_URL || "http://89.167.60.81:9800";
const ARENA_DIR = join(HOME, "arena-hub");
const CURSOR_DIR = join(HOME, ".arena-cursors");
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || join(HOME, "clawd");
const INBOX_DIR = join(WORKSPACE, "arena-inbox");

// --- bot identity mapping ---
// ~/arena-hub/bots.json: { "7997448414": "sura", "8566320139": "panda" }
// maps telegram bot ID → token name. each bot gets its own token file.

type BotMap = Record<string, string>;

let botMap: BotMap | null = null;
function getBotMap(): BotMap {
  if (!botMap) {
    try {
      botMap = JSON.parse(readFileSync(join(ARENA_DIR, "bots.json"), "utf-8"));
    } catch {
      botMap = {};
    }
  }
  return botMap!;
}

// cache tokens per bot name
const tokenCache: Record<string, string> = {};
function getTokenForBot(botName: string): string | null {
  if (tokenCache[botName]) return tokenCache[botName];
  try {
    const t = readFileSync(join(ARENA_DIR, `.arena-token-${botName}`), "utf-8").trim();
    tokenCache[botName] = t;
    return t;
  } catch {
    return null;
  }
}

// fallback token (for read operations / legacy)
function getDefaultToken(): string {
  return readFileSync(join(ARENA_DIR, ".arena-token"), "utf-8").trim();
}

function resolveRoom(event: MessageEvent): string | null {
  const groupId = String(event.context.groupId ?? "");
  const sessionKey = event.sessionKey ?? "";
  const match = sessionKey.match(/telegram:group:(-\d+)/);
  const resolved = match ? match[1] : groupId;
  if (!resolved || !resolved.startsWith("-")) return null;
  return `telegram:${resolved}`;
}

function resolveBotId(event: MessageEvent): string {
  return String(event.context.botId ?? event.context.senderId ?? "");
}

// --- cursor per room ---

function getCursor(room: string): number {
  try {
    return parseInt(readFileSync(join(CURSOR_DIR, room.replace(/:/g, "_")), "utf-8").trim(), 10) || 0;
  } catch { return 0; }
}

function saveCursor(room: string, id: number): void {
  mkdirSync(CURSOR_DIR, { recursive: true });
  writeFileSync(join(CURSOR_DIR, room.replace(/:/g, "_")), String(id), "utf-8");
}

// --- outbound: POST event to hub ---

async function pushEvent(room: string, token: string, event: MessageEvent): Promise<void> {
  const sessionKey = event.sessionKey ?? "";
  const message = String(event.context.message ?? event.context.text ?? "");
  const groupMatch = sessionKey.match(/telegram:group:(-\d+)/);
  const groupId = groupMatch ? groupMatch[1] : "";

  const payload = { session: sessionKey, message, groupId };

  try {
    const res = await fetch(`${HUB_URL}/events`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ room, kind: "bot:message", payload }),
    });
    if (!res.ok) {
      console.error(`[arena-client] POST /events ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("[arena-client] push error:", err);
  }
}

// --- inbound: GET events from hub, write inbox ---
// (backup for when listener daemon is down)

async function pullEvents(room: string): Promise<void> {
  const since = getCursor(room);
  let token: string;
  try { token = getDefaultToken(); } catch { return; }

  let events: HubEvent[];
  try {
    const res = await fetch(
      `${HUB_URL}/events?rooms=${encodeURIComponent(room)}&since=${since}&limit=50`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (!res.ok) return;
    const data = (await res.json()) as { events: HubEvent[]; cursor: number };
    events = data.events ?? [];
  } catch { return; }

  if (events.length === 0) return;

  const maxId = Math.max(...events.map((e) => e.id));
  if (maxId > since) saveCursor(room, maxId);

  // write all events (listener handles realtime, this is fallback)
  mkdirSync(INBOX_DIR, { recursive: true });
  const inboxFile = join(INBOX_DIR, `${room.replace(/:/g, "_")}.md`);
  const lines = events.map((e) => {
    let text = e.payload;
    try {
      const p = JSON.parse(e.payload);
      text = p.message ?? p.text ?? e.payload;
    } catch { /* raw */ }
    if (text.length > 500) text = text.slice(0, 500) + "…";
    const ts = e.created_at.replace("T", " ").slice(0, 19);
    return `- **${e.author}** (${ts}): ${text}`;
  });
  const content = `# arena inbox: ${room}\n\n_updated: ${new Date().toISOString()}, events: ${since}→${maxId}_\n\n${lines.join("\n\n")}\n`;
  writeFileSync(inboxFile, content, "utf-8");
}

// --- main handler ---

export default async function handler(event: MessageEvent): Promise<void> {
  if (event.type !== "message") return;

  const room = resolveRoom(event);
  if (!room) return;

  if (event.action === "sent") {
    // per-bot outbound: resolve bot identity → use its token
    const botId = resolveBotId(event);
    const map = getBotMap();
    const botName = map[botId];

    if (!botName) {
      // unknown bot, skip to avoid misattribution
      console.error(`[arena-client] skip outbound: unknown bot ${botId}`);
      return;
    }

    const token = getTokenForBot(botName);
    if (!token) {
      console.error(`[arena-client] skip outbound: no token for ${botName}`);
      return;
    }

    await pushEvent(room, token, event);
  } else if (event.action === "received") {
    if (event.context.isBot) return;
    await pullEvents(room);
  }
}
