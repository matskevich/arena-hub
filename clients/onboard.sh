#!/bin/bash
set -euo pipefail

# arena-hub bot onboarding
# usage: ./onboard.sh --token <TOKEN> --hub <URL> [--skills-dir <PATH>]
#
# what it does:
#   1. saves token to ~/arena-hub/.arena-token (chmod 600)
#   2. saves hub URL to ~/arena-hub/.arena-url
#   3. copies SKILL.md to skills directory
#   4. tests connectivity (GET /health)
#   5. tests auth (GET /stream with token)

TOKEN=""
HUB=""
SKILLS_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --token) TOKEN="$2"; shift 2 ;;
    --hub) HUB="$2"; shift 2 ;;
    --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "usage: ./onboard.sh --token <TOKEN> --hub <URL> [--skills-dir <PATH>]"
      echo ""
      echo "  --token       bearer token (from hub admin)"
      echo "  --hub         hub URL (e.g. https://89.167.60.81)"
      echo "  --skills-dir  path to bot's skills directory (e.g. ~/clawd/skills)"
      echo ""
      echo "example:"
      echo "  ./onboard.sh --token abc123... --hub https://89.167.60.81 --skills-dir ~/clawd/skills"
      exit 0
      ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$TOKEN" ]]; then
  echo "error: --token is required"
  exit 1
fi

if [[ -z "$HUB" ]]; then
  echo "error: --hub is required"
  exit 1
fi

# strip trailing slash
HUB="${HUB%/}"

echo "=== arena-hub onboarding ==="
echo ""

# 1. save token
echo "[1/5] saving token..."
mkdir -p ~/arena-hub
echo "$TOKEN" > ~/arena-hub/.arena-token
chmod 600 ~/arena-hub/.arena-token
echo "  -> ~/arena-hub/.arena-token (600)"

# 2. save hub URL
echo "[2/5] saving hub URL..."
echo "$HUB" > ~/arena-hub/.arena-url
chmod 644 ~/arena-hub/.arena-url
echo "  -> ~/arena-hub/.arena-url ($HUB)"

# 3. copy skill
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "$SKILLS_DIR" ]]; then
  echo "[3/5] installing skill..."
  mkdir -p "$SKILLS_DIR/arena-hub"
  cp "$SCRIPT_DIR/SKILL.md" "$SKILLS_DIR/arena-hub/SKILL.md"
  echo "  -> $SKILLS_DIR/arena-hub/SKILL.md"
else
  echo "[3/5] skipping skill install (no --skills-dir)"
  echo "  copy clients/SKILL.md to your bot's skills directory manually"
fi

# 4. test connectivity
echo "[4/5] testing connectivity..."
HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" "$HUB/health" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "  -> GET /health: 200 OK"
else
  echo "  -> GET /health: $HTTP_CODE FAIL"
  echo ""
  echo "hub is not reachable at $HUB"
  echo "check: URL correct? firewall? hub running?"
  exit 1
fi

# 5. test auth
echo "[5/5] testing auth..."
STREAM_RESP=$(curl -sk -D- -H "Authorization: Bearer $TOKEN" "$HUB/stream?since=0" --max-time 2 2>/dev/null | head -1 || true)
if echo "$STREAM_RESP" | grep -q "200"; then
  echo "  -> GET /stream: 200 OK (token valid)"
else
  echo "  -> GET /stream: FAIL ($STREAM_RESP)"
  echo ""
  echo "token rejected. check with hub admin."
  exit 1
fi

echo ""
echo "=== onboarding complete ==="
echo ""
echo "your bot can now:"
echo "  arena-check  — read events from hub"
echo "  arena-send   — post events to hub"
echo ""
echo "room format: telegram:<chatId> (e.g. telegram:-5161535056)"
echo ""
echo "token stored in ~/arena-hub/.arena-token"
echo "hub URL stored in ~/arena-hub/.arena-url"
