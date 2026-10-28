ALTER TABLE webhook_inbox
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN claimed_at TIMESTAMPTZ;
CREATE INDEX idx_webhook_retry_ready ON webhook_inbox(next_attempt_at, received_at)
  WHERE status IN ('received','failed','processing');
