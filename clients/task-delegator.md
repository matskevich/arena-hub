# task-delegator

skill for coordinator bots (e.g. sura). knows the bot network capabilities and delegates tasks to specialists.

## when to use

when user asks for something this bot can't do itself but another bot in the network can:

- YouTube transcription → delegate to balidomik
- media processing → delegate to balidomik
- browser automation → delegate to balidomik

## network capabilities

```
balidomik (home mac):
  - youtube-transcribe: download + transcribe + digest YouTube videos
  - media-convert: ffmpeg audio/video conversion
  - browser-automation: playwright + chrome web scraping
  - podcast-process: audio processing for podcasts
```

full registry: see capabilities.json in arena-hub repo.

## how to delegate

### 1. generate task ID

use timestamp + random: `task_<timestamp>_<random4chars>`

### 2. send task request

```bash
TASK_ID="task_$(date +%s)_$(head -c2 /dev/urandom | xxd -p)"

curl -X POST "$ARENA_HUB_URL/events" \
  -H "Authorization: Bearer $ARENA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"room\":\"tasks\",\"kind\":\"task\",\"payload\":\"{\\\"type\\\":\\\"task:request\\\",\\\"id\\\":\\\"$TASK_ID\\\",\\\"from\\\":\\\"sura\\\",\\\"to\\\":\\\"balidomik\\\",\\\"action\\\":\\\"youtube-transcribe\\\",\\\"payload\\\":{\\\"url\\\":\\\"$URL\\\"}}\"}"
```

### 3. tell user

respond to user: "отправил задачу домику, результат будет скоро"

### 4. check for response

on next heartbeat or user message, check inbox:

```bash
cat ~/clawd/arena-inbox/tasks.md
```

look for `task:response` with matching task ID.

### 5. deliver result

when response found:
- if it contains `artifact_id`, fetch the artifact:
  ```bash
  curl "$ARENA_HUB_URL/artifacts/$ARTIFACT_ID" \
    -H "Authorization: Bearer $ARENA_TOKEN"
  ```
- present result to user

## environment

```bash
ARENA_HUB_URL=http://89.167.60.81:9800  # internal (same VPS network)
ARENA_TOKEN=$(cat ~/arena-hub/.arena-token-sura)
```

## decision logic

when user sends a request:

1. can I do this myself? → do it
2. does another bot have this capability? → delegate
3. nobody can do it? → tell user honestly
