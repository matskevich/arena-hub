import { EventBody } from './types.js';

const MAX_PAYLOAD_BYTES = 32 * 1024; // 32KB

export type ValidationResult = {
  ok: true;
  body: EventBody;
} | {
  ok: false;
  error: string;
  status: number;
}

export function validateEventBody(raw: Buffer): ValidationResult {
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: 'payload exceeds 32KB limit', status: 413 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch {
    return { ok: false, error: 'invalid JSON', status: 400 };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'body must be a JSON object', status: 400 };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.room !== 'string' || obj.room.length === 0) {
    return { ok: false, error: 'missing or empty "room" field', status: 400 };
  }
  if (typeof obj.kind !== 'string' || obj.kind.length === 0) {
    return { ok: false, error: 'missing or empty "kind" field', status: 400 };
  }
  if (obj.payload === undefined) {
    return { ok: false, error: 'missing "payload" field', status: 400 };
  }

  return {
    ok: true,
    body: {
      room: obj.room,
      kind: obj.kind,
      payload: obj.payload,
    },
  };
}
