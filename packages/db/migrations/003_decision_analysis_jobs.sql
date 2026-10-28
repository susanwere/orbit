CREATE TABLE decision_analysis_jobs (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ignored','proposed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  failure_reason TEXT,
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_decision_analysis_ready ON decision_analysis_jobs(next_attempt_at)
WHERE status IN ('pending','failed','processing');
