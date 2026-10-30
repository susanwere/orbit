-- A GitHub CI run must be tied to the specific Muse job's delivered code.
-- These fields are populated only by a separately authorized delivery worker,
-- never from browser-supplied evidence parameters.
ALTER TABLE muse_execution_jobs
  ADD COLUMN github_repository TEXT,
  ADD COLUMN github_pull_number INTEGER CHECK (github_pull_number > 0),
  ADD COLUMN github_head_sha TEXT CHECK (github_head_sha ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT muse_github_binding_complete CHECK (
    (github_repository IS NULL AND github_pull_number IS NULL AND github_head_sha IS NULL)
    OR
    (github_repository IS NOT NULL AND github_pull_number IS NOT NULL AND github_head_sha IS NOT NULL)
  );
