#!/usr/bin/env bash
set -euo pipefail

# arena-client onboard v2
# One-command setup for any bot to join arena-hub
#
# Usage:
#   ./onboard.sh --bot sura --token <token> --bot-id 7997448414
#   ./onboard.sh --bot panda --token <token> --bot-id 8566320139
#   ./onboard.sh --bot panda --token <token> --bot-id 8566320139 --hub http://89.167.60.81:9800
#
# What it does:
#   1. Creates identity files (author, bot-id, token)
#   2. Installs arena-listener daemon (if not running)
#   3. Installs arena-client hook (outbound push)
#   4. Tests hub connectivity
#   5. Sends "joined arena" event

ARENA_HUB_URL="${ARENA_HUB_URL:-http://89.167.60.81:9800}"
ARENA_DIR="$HOME/arena-hub"
CURSOR_DIR="$HOME/.arena-cursors"
HOOKS_DIR=""  # set after parsing args
BOT_NAME=""
BOT_TOKEN=""
BOT_ID=""
WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/clawd}"
INBOX_DIR="$WORKSPACE/arena-inbox"

# --- parse args ---

while [[ $# -gt 0 ]]; do
  case $1 in
    --bot) BOT_NAME="$2"; shift 2 ;;
    --token) BOT_TOKEN="$2"; shift 2 ;;
    --bot-id) BOT_ID="$2"; shift 2 ;;
    --hub) ARENA_HUB_URL="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; INBOX_DIR="$WORKSPACE/arena-inbox"; shift 2 ;;
    --hooks-dir) HOOKS_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$BOT_NAME" || -z "$BOT_TOKEN" ]]; then
  echo "usage: $0 --bot <name> --token <token> [--bot-id <telegram_id>] [--hub <url>]"
  exit 1
fi

HOOKS_DIR="${HOOKS_DIR:-$WORKSPACE/hooks/arena-client}"

echo "=== arena-client onboard v2 ==="
echo "bot:       $BOT_NAME"
echo "hub:       $ARENA_HUB_URL"
echo "workspace: $WORKSPACE"
echo "hooks:     $HOOKS_DIR"
echo ""

# --- 1. directories ---

echo "[1/6] creating directories..."
mkdir -p "$ARENA_DIR" "$CURSOR_DIR" "$INBOX_DIR" "$HOOKS_DIR"

# --- 2. identity files ---

echo "[2/6] writing identity files..."
echo "$BOT_TOKEN" > "$ARENA_DIR/.arena-token-$BOT_NAME"
chmod 600 "$ARENA_DIR/.arena-token-$BOT_NAME"
echo "$BOT_NAME" > "$ARENA_DIR/.arena-author-$BOT_NAME"
if [[ -n "$BOT_ID" ]]; then
  echo "$BOT_ID" > "$ARENA_DIR/.arena-bot-id-$BOT_NAME"
fi

# symlink: .arena-token → first bot's token (for listener)
if [[ ! -f "$ARENA_DIR/.arena-token" ]]; then
  ln -sf ".arena-token-$BOT_NAME" "$ARENA_DIR/.arena-token"
  echo "  → linked .arena-token to $BOT_NAME (listener will use this)"
fi

# legacy compat: .arena-author (for arena-client hook)
echo "$BOT_NAME" > "$ARENA_DIR/.arena-author"
if [[ -n "$BOT_ID" ]]; then
  echo "$BOT_ID" > "$ARENA_DIR/.arena-bot-id"
fi

# --- 3. arena-listener daemon ---

echo "[3/6] setting up arena-listener..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LISTENER_SRC="$SCRIPT_DIR/arena-listener.mjs"

if [[ -f "$LISTENER_SRC" ]] && [[ "$(realpath "$LISTENER_SRC")" != "$(realpath "$HOOKS_DIR/arena-listener.mjs" 2>/dev/null)" ]]; then
  cp "$LISTENER_SRC" "$HOOKS_DIR/arena-listener.mjs"
  echo "  → copied arena-listener.mjs"
elif [[ -f "$HOOKS_DIR/arena-listener.mjs" ]]; then
  echo "  → arena-listener.mjs already in place"
else
  echo "  ! arena-listener.mjs not found in $SCRIPT_DIR, skipping"
fi

# systemd service
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

cat > "$SYSTEMD_DIR/arena-listener.service" << EOF
[Unit]
Description=Arena Hub Listener — real-time SSE inbound
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node $HOOKS_DIR/arena-listener.mjs
Environment=ARENA_HUB_URL=$ARENA_HUB_URL
Environment=ARENA_TOKEN_FILE=$ARENA_DIR/.arena-token
Environment=ARENA_WORKSPACE=$WORKSPACE
Environment=NODE_NO_WARNINGS=1
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload

if systemctl --user is-active arena-listener >/dev/null 2>&1; then
  echo "  → arena-listener already running, restarting..."
  systemctl --user restart arena-listener
else
  echo "  → starting arena-listener..."
  systemctl --user enable --now arena-listener
fi

sleep 2
if systemctl --user is-active arena-listener >/dev/null 2>&1; then
  echo "  ✓ arena-listener running"
else
  echo "  ✗ arena-listener failed to start!"
  journalctl --user -u arena-listener --since "10 sec ago" --no-pager | tail -5
fi

# --- 4. arena-client hook ---

echo "[4/6] installing arena-client hook..."
HANDLER_SRC="$SCRIPT_DIR/handler.ts"
HOOK_MD_SRC="$SCRIPT_DIR/HOOK.md"

if [[ -f "$HANDLER_SRC" ]] && [[ "$(realpath "$HANDLER_SRC")" != "$(realpath "$HOOKS_DIR/handler.ts" 2>/dev/null)" ]]; then
  cp "$HANDLER_SRC" "$HOOKS_DIR/handler.ts"
  echo "  → copied handler.ts"
elif [[ -f "$HOOKS_DIR/handler.ts" ]]; then
  echo "  → handler.ts already in place"
fi
if [[ -f "$HOOK_MD_SRC" ]] && [[ "$(realpath "$HOOK_MD_SRC")" != "$(realpath "$HOOKS_DIR/HOOK.md" 2>/dev/null)" ]]; then
  cp "$HOOK_MD_SRC" "$HOOKS_DIR/HOOK.md"
  echo "  → copied HOOK.md"
elif [[ -f "$HOOKS_DIR/HOOK.md" ]]; then
  echo "  → HOOK.md already in place"
fi
if [[ ! -f "$HOOKS_DIR/package.json" ]]; then
  echo '{"type": "module"}' > "$HOOKS_DIR/package.json"
fi

# --- 5. test connectivity ---

echo "[5/6] testing hub connectivity..."
HEALTH=$(curl -sS --connect-timeout 5 "$ARENA_HUB_URL/health" 2>&1) || true
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "  ✓ hub is healthy"
else
  echo "  ✗ hub health check failed: $HEALTH"
fi

# test auth
TOKEN_FILE="$ARENA_DIR/.arena-token-$BOT_NAME"
AUTH_TEST=$(curl -sS --connect-timeout 5 \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  "$ARENA_HUB_URL/events?limit=1" 2>&1) || true
if echo "$AUTH_TEST" | grep -q '"events"'; then
  echo "  ✓ token works"
else
  echo "  ✗ token test failed: $AUTH_TEST"
fi

# --- 6. announce ---

echo "[6/6] announcing to hub..."
ANNOUNCE=$(curl -sS --connect-timeout 5 \
  -X POST "$ARENA_HUB_URL/events" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -H "Content-Type: application/json" \
  -d "{\"room\":\"arena:system\",\"kind\":\"bot:joined\",\"payload\":\"$BOT_NAME joined arena\"}" 2>&1) || true

if echo "$ANNOUNCE" | grep -q '"id"'; then
  EVENT_ID=$(echo "$ANNOUNCE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  echo "  ✓ announced (event $EVENT_ID)"
else
  echo "  → announce skipped: $ANNOUNCE"
fi

echo ""
echo "=== done ==="
echo ""
echo "bot $BOT_NAME is now connected to arena-hub."
echo ""
echo "inbox files:  $INBOX_DIR/"
echo "token:        $TOKEN_FILE"
echo "listener:     systemctl --user status arena-listener"
echo "logs:         journalctl --user -u arena-listener -f"
echo ""
echo "to test: write a message in any arena group."
echo "the bot will see new events in $INBOX_DIR/ in real-time."
