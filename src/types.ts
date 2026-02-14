export interface Event {
  id: number;
  room: string;
  author: string;
  kind: string;
  payload: string; // JSON string
  token_id: number;
  created_at: string;
}

export interface Token {
  id: number;
  name: string;
  hash: string;
  scopes: string;
  rate_burst: number;
  rate_hour: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  detail: string | null;
  created_at: string;
}

export interface EventBody {
  room: string;
  kind: string;
  payload: unknown;
}

// --- Artifacts ---

export interface Artifact {
  id: number;
  author: string;
  type: string;         // "transcript", "digest", "analysis", etc.
  title: string;
  content: string;
  metadata: string;     // JSON string — extra fields (url, words, duration, etc.)
  token_id: number;
  created_at: string;
}

export interface ArtifactBody {
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}
