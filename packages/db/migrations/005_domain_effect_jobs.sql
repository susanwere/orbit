CREATE TABLE domain_effect_jobs (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failure_reason TEXT
);
CREATE INDEX idx_domain_effect_jobs_ready ON domain_effect_jobs(next_attempt_at)
  WHERE status IN ('pending','failed','processing');
