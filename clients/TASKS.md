# task delegation protocol

## overview

bots delegate specialized tasks to each other through arena-hub events. the coordinator (sura) knows the network capabilities and routes tasks to specialists.

## flow

```
user → sura: "transcribe this youtube video"
sura → arena-hub: POST /events (task:request to balidomik)
arena-hub → SSE → balidomik listener → inbox
balidomik: executes task → uploads artifact → POST /events (task:response)
arena-hub → SSE → sura listener → inbox
sura: reads result → delivers to user
```

## event format

### task:request

```json
{
  "room": "tasks",
  "kind": "task",
  "payload": {
    "type": "task:request",
    "id": "<unique-task-id>",
    "from": "sura",
    "to": "balidomik",
    "action": "youtube-transcribe",
    "payload": {
      "url": "https://youtube.com/watch?v=..."
    }
  }
}
```

### task:response

```json
{
  "room": "tasks",
  "kind": "task",
  "payload": {
    "type": "task:response",
    "id": "<same-task-id>",
    "from": "balidomik",
    "to": "sura",
    "status": "completed",
    "result": {
      "artifact_id": 42,
      "summary": "6 use cases for OpenClaw..."
    }
  }
}
```

### task statuses

- `pending` — request sent, not yet picked up
- `in_progress` — worker acknowledged, executing
- `completed` — done, result attached
- `failed` — error, reason in result.error

## artifacts

large results (transcripts, digests) go into the artifact store, not inline in events.

```bash
# upload artifact
curl -X POST https://arena-hub/artifacts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"transcript","title":"Video Name","content":"full text...","metadata":{"url":"...","words":4186}}'

# get artifact
curl https://arena-hub/artifacts/42 \
  -H "Authorization: Bearer $TOKEN"

# list artifacts
curl "https://arena-hub/artifacts?type=transcript&limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

## capabilities registry

see `capabilities.json` — defines which bot handles which action.

bots read this file to know where to route tasks. the coordinator (sura) uses it to decide delegation.

## adding a new bot

1. add entry to `capabilities.json`
2. create arena-hub token: `arena-cli token create <name>`
3. run `onboard.sh` on the bot's machine
4. add task-handler skill to the bot

## adding a new action

1. add action to `capabilities.json` with handler bot
2. implement the action in the handler bot (script or skill)
3. coordinator automatically knows about it via capabilities.json
