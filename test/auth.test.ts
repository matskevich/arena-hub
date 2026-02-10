import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, insertToken } from '../src/db.js';
import { authenticate, checkRateLimit, hashToken, clearRateLimits } from '../src/auth.js';
import Database from 'better-sqlite3';
import { Token } from '../src/types.js';

let db: Database.Database;

describe('auth', () => {
  before(() => {
    db = initDb(':memory:');
  });

  after(() => {
    db.close();
  });

  beforeEach(() => {
    clearRateLimits();
  });

  describe('authenticate', () => {
    it('rejects missing header', () => {
      const result = authenticate(undefined);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 401);
      }
    });

    it('rejects malformed header', () => {
      const result = authenticate('Basic abc');
      assert.equal(result.ok, false);
    });

    it('rejects unknown token', () => {
      const result = authenticate('Bearer unknowntoken123');
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 401);
    });

    it('accepts valid token', () => {
      const raw = 'test-valid-token-001';
      const hash = hashToken(raw);
      insertToken('test-bot', hash, '*', 10, 1000, null);

      const result = authenticate(`Bearer ${raw}`);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.token.name, 'test-bot');
      }
    });

    it('rejects expired token', () => {
      const raw = 'test-expired-token-001';
      const hash = hashToken(raw);
      const past = new Date(Date.now() - 86400_000).toISOString();
      insertToken('expired-bot', hash, '*', 10, 1000, past);

      const result = authenticate(`Bearer ${raw}`);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /expired/);
    });

    it('rejects revoked token', () => {
      const raw = 'test-revoked-token-001';
      const hash = hashToken(raw);
      const token = insertToken('revoked-bot', hash, '*', 10, 1000, null);
      // manually revoke
      db.prepare("UPDATE tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%f','now') WHERE id = ?").run(token.id);

      const result = authenticate(`Bearer ${raw}`);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /revoked/);
    });
  });

  describe('rate limiting', () => {
    it('allows requests within burst', () => {
      const token: Token = {
        id: 9999, name: 'rate-test', hash: '', scopes: '*',
        rate_burst: 5, rate_hour: 1000,
        expires_at: null, revoked_at: null, created_at: '',
      };

      for (let i = 0; i < 5; i++) {
        const result = checkRateLimit(token);
        assert.equal(result.ok, true);
      }

      const result = checkRateLimit(token);
      assert.equal(result.ok, false);
    });

    it('allows requests within hourly limit', () => {
      const token: Token = {
        id: 9998, name: 'hour-test', hash: '', scopes: '*',
        rate_burst: 100, rate_hour: 3,
        expires_at: null, revoked_at: null, created_at: '',
      };

      for (let i = 0; i < 3; i++) {
        const result = checkRateLimit(token);
        assert.equal(result.ok, true);
      }

      const result = checkRateLimit(token);
      assert.equal(result.ok, false);
    });
  });
});
