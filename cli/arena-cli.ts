import { randomBytes, createHash } from 'node:crypto';
import { initDb, insertToken, revokeToken, listTokens, getToken, auditLog, getAuditLog } from '../src/db.js';

const DB_PATH = process.env.ARENA_HUB_DB || './arena-hub.db';

function usage(): never {
  console.log(`arena-cli — token management for arena-hub

usage:
  arena-cli issue --name <name> [--ttl <duration>] [--scopes <scopes>] [--burst <n>] [--hour <n>]
  arena-cli revoke --id <id>
  arena-cli rotate --id <id> [--ttl <duration>]
  arena-cli list
  arena-cli audit [--limit <n>]

options:
  --name    token name / bot identifier (required for issue)
  --ttl     time-to-live: 1h, 24h, 7d, 90d (default: 90d)
  --scopes  comma-separated scopes (default: *)
  --burst   max burst rate (default: 10)
  --hour    max hourly rate (default: 1000)
  --id      token id (required for revoke/rotate)
  --limit   audit log entries to show (default: 50)
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      const key = argv[i]!.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.set(key, next);
        i++;
      } else {
        args.set(key, 'true');
      }
    }
  }
  return args;
}

function parseTtl(ttl: string): number {
  const match = ttl.match(/^(\d+)(h|d)$/);
  if (!match) {
    console.error(`invalid ttl: ${ttl} (use e.g. 1h, 24h, 7d, 90d)`);
    process.exit(1);
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'h' ? value * 3600_000 : value * 86400_000;
  return ms;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function cmdIssue(args: Map<string, string>): void {
  const name = args.get('name');
  if (!name) {
    console.error('--name is required');
    process.exit(1);
  }

  const ttl = args.get('ttl') || '90d';
  const scopes = args.get('scopes') || '*';
  const burst = parseInt(args.get('burst') || '10', 10);
  const hour = parseInt(args.get('hour') || '1000', 10);

  const rawToken = randomBytes(32).toString('hex');
  const hash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + parseTtl(ttl)).toISOString();

  const token = insertToken(name, hash, scopes, burst, hour, expiresAt);
  auditLog('token_issued', `id=${token.id} name=${name} ttl=${ttl} scopes=${scopes}`);

  console.log(`token issued:`);
  console.log(`  id:      ${token.id}`);
  console.log(`  name:    ${name}`);
  console.log(`  token:   ${rawToken}`);
  console.log(`  expires: ${expiresAt}`);
  console.log(`  scopes:  ${scopes}`);
  console.log(`\nstore this token securely — it cannot be retrieved again.`);
}

function cmdRevoke(args: Map<string, string>): void {
  const id = parseInt(args.get('id') || '', 10);
  if (!id) {
    console.error('--id is required');
    process.exit(1);
  }

  const token = getToken(id);
  if (!token) {
    console.error(`token id=${id} not found`);
    process.exit(1);
  }
  if (token.revoked_at) {
    console.error(`token id=${id} already revoked at ${token.revoked_at}`);
    process.exit(1);
  }

  revokeToken(id);
  auditLog('token_revoked', `id=${id} name=${token.name}`);
  console.log(`token id=${id} (${token.name}) revoked.`);
}

function cmdRotate(args: Map<string, string>): void {
  const id = parseInt(args.get('id') || '', 10);
  if (!id) {
    console.error('--id is required');
    process.exit(1);
  }

  const oldToken = getToken(id);
  if (!oldToken) {
    console.error(`token id=${id} not found`);
    process.exit(1);
  }

  // issue new token with same config
  const ttl = args.get('ttl') || '90d';
  const rawToken = randomBytes(32).toString('hex');
  const hash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + parseTtl(ttl)).toISOString();

  const newToken = insertToken(oldToken.name, hash, oldToken.scopes, oldToken.rate_burst, oldToken.rate_hour, expiresAt);

  // revoke old
  revokeToken(id);
  auditLog('token_rotated', `old_id=${id} new_id=${newToken.id} name=${oldToken.name}`);

  console.log(`token rotated:`);
  console.log(`  old id:  ${id} (now revoked)`);
  console.log(`  new id:  ${newToken.id}`);
  console.log(`  name:    ${oldToken.name}`);
  console.log(`  token:   ${rawToken}`);
  console.log(`  expires: ${expiresAt}`);
  console.log(`\nupdate the bot config, then verify connectivity.`);
}

function cmdList(): void {
  const tokens = listTokens();
  if (tokens.length === 0) {
    console.log('no tokens.');
    return;
  }

  console.log('id  | name             | scopes | burst | hour | expires              | revoked');
  console.log('----|------------------|--------|-------|------|----------------------|--------');
  for (const t of tokens) {
    const revoked = t.revoked_at ? t.revoked_at.slice(0, 19) : '-';
    const expires = t.expires_at ? t.expires_at.slice(0, 19) : 'never';
    console.log(
      `${String(t.id).padEnd(4)}| ${t.name.padEnd(17)}| ${t.scopes.padEnd(7)}| ${String(t.rate_burst).padEnd(6)}| ${String(t.rate_hour).padEnd(5)}| ${expires.padEnd(21)}| ${revoked}`
    );
  }
}

function cmdAudit(args: Map<string, string>): void {
  const limit = parseInt(args.get('limit') || '50', 10);
  const entries = getAuditLog(limit);
  if (entries.length === 0) {
    console.log('no audit entries.');
    return;
  }
  for (const e of entries) {
    console.log(`[${e.created_at}] ${e.action}: ${e.detail || '-'}`);
  }
}

// --- Main ---

const [,, command, ...rest] = process.argv;
const args = parseArgs(rest);

if (!command || command === '--help' || command === '-h') {
  usage();
}

initDb(DB_PATH);

switch (command) {
  case 'issue':
    cmdIssue(args);
    break;
  case 'revoke':
    cmdRevoke(args);
    break;
  case 'rotate':
    cmdRotate(args);
    break;
  case 'list':
    cmdList();
    break;
  case 'audit':
    cmdAudit(args);
    break;
  default:
    console.error(`unknown command: ${command}`);
    usage();
}
