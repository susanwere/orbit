-- Separate opt-in GitHub delivery from model execution. No delivery is automatic.
ALTER TABLE muse_execution_jobs
  ADD COLUMN delivery_requested_at TIMESTAMPTZ,
  ADD COLUMN delivery_requested_by_principal_id TEXT REFERENCES principals(id),
  ADD COLUMN delivery_state TEXT CHECK (delivery_state IN ('REQUESTED','RUNNING','FINISHED','ERROR')),
  ADD COLUMN delivery_error TEXT;
CREATE INDEX muse_delivery_requests_pending ON muse_execution_jobs(delivery_requested_at,id)
  WHERE delivery_state='REQUESTED';
