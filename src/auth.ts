import { createHash } from 'node:crypto';
import { findTokenByHash, auditLog } from './db.js';
import { Token } from './types.js';

// --- Token hashing ---

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// --- Token validation ---

export interface AuthSuccess {
  ok: true;
  token: Token;
}

export interface AuthFailure {
  ok: false;
  error: string;
  status: number;
}

export function authenticate(authHeader: string | undefined): AuthSuccess | AuthFailure {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, error: 'missing or malformed Authorization header', status: 401 };
  }

  const raw = authHeader.slice(7);
  if (raw.length === 0) {
    return { ok: false, error: 'empty bearer token', status: 401 };
  }

  const hash = hashToken(raw);
  const token = findTokenByHash(hash);

  if (!token) {
    auditLog('auth_fail', `unknown token hash ${hash.slice(0, 8)}...`);
    return { ok: false, error: 'invalid token', status: 401 };
  }

  if (token.revoked_at) {
    auditLog('auth_fail', `revoked token id=${token.id} name=${token.name}`);
    return { ok: false, error: 'token revoked', status: 401 };
  }

  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    auditLog('auth_fail', `expired token id=${token.id} name=${token.name}`);
    return { ok: false, error: 'token expired', status: 401 };
  }

  return { ok: true, token };
}

// --- In-memory rate limiter ---
// Token bucket for burst + sliding window for hourly

interface RateState {
  // burst: token bucket
  tokens: number;
  lastRefill: number;
  // hourly: sliding window
  hourCounts: number[];
  hourStart: number;
}

const rateLimits = new Map<number, RateState>();

export function checkRateLimit(token: Token): { ok: true } | { ok: false; error: string; retryAfter: number } {
  const now = Date.now();
  let state = rateLimits.get(token.id);

  if (!state) {
    state = {
      tokens: token.rate_burst,
      lastRefill: now,
      hourCounts: [],
      hourStart: now,
    };
    rateLimits.set(token.id, state);
  }

  // refill burst tokens (1 per 100ms = 10/sec)
  const elapsed = now - state.lastRefill;
  const refill = Math.floor(elapsed / 100);
  if (refill > 0) {
    state.tokens = Math.min(token.rate_burst, state.tokens + refill);
    state.lastRefill = now;
  }

  // check burst
  if (state.tokens <= 0) {
    return { ok: false, error: 'rate limit exceeded (burst)', retryAfter: 1 };
  }

  // check hourly window
  const hourAgo = now - 3600_000;
  if (state.hourStart < hourAgo) {
    // reset window
    state.hourCounts = state.hourCounts.filter(t => t > hourAgo);
    state.hourStart = hourAgo;
  }
  if (state.hourCounts.length >= token.rate_hour) {
    const oldest = state.hourCounts[0]!;
    const retryAfter = Math.ceil((oldest + 3600_000 - now) / 1000);
    return { ok: false, error: 'rate limit exceeded (hourly)', retryAfter };
  }

  // consume
  state.tokens--;
  state.hourCounts.push(now);
  return { ok: true };
}

export function clearRateLimits(): void {
  rateLimits.clear();
}
