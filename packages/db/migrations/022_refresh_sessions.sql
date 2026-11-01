-- Opaque browser credentials are hashed; rotation preserves the absolute expiry.
CREATE TABLE auth_refresh_sessions (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_refresh_sessions_expiry ON auth_refresh_sessions(expires_at);
