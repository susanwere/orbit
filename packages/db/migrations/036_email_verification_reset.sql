ALTER TABLE auth_password_accounts
  ADD COLUMN email_verified_at TIMESTAMPTZ;
-- Accounts created before verification was available retain access.
UPDATE auth_password_accounts SET email_verified_at = created_at;
CREATE TABLE auth_email_tokens (
  token_hash TEXT PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  principal_id TEXT NOT NULL REFERENCES auth_password_accounts(principal_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_email_tokens_principal ON auth_email_tokens(principal_id,purpose);
