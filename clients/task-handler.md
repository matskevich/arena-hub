# task-handler

skill for worker bots (e.g. balidomik). reads task requests from arena inbox, executes them, sends results back.

## when to use

- on heartbeat or when checking inbox
- when inbox contains a `task:request` addressed to this bot

## how to check for tasks

read the arena inbox file for the `tasks` room:

```bash
cat ~/clawd/arena-inbox/tasks.md
```

look for lines containing `task:request` and `"to": "<your-bot-name>"`.

## how to execute

1. parse the task request from inbox
2. based on `action` field, run the appropriate handler:

| action | what to do |
|--------|-----------|
| `youtube-transcribe` | `bash ~/clawd/scripts/transcribe.sh "$url"` → read output file → create digest |
| `media-convert` | download artifact from hub → convert with ffmpeg → upload result |

3. upload result as artifact:

```bash
curl -X POST "$ARENA_HUB_URL/artifacts" \
  -H "Authorization: Bearer $ARENA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"transcript","title":"...","content":"...full transcript...","metadata":{"url":"...","words":N}}'
```

4. send task:response event:

```bash
curl -X POST "$ARENA_HUB_URL/events" \
  -H "Authorization: Bearer $ARENA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"room":"tasks","kind":"task","payload":"{\"type\":\"task:response\",\"id\":\"TASK_ID\",\"from\":\"balidomik\",\"to\":\"REQUESTER\",\"status\":\"completed\",\"result\":{\"artifact_id\":N,\"summary\":\"...\"}}"}'
```

## environment

```bash
ARENA_HUB_URL=https://arena.matskevichlab.com  # or http://89.167.60.81:9800
ARENA_TOKEN=$(cat ~/arena-hub/.arena-token-balidomik)
```

## error handling

if task fails, send response with `"status": "failed"` and `"result": {"error": "reason"}`.
