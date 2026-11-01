ALTER TABLE project_knowledge_snapshots
  ADD COLUMN review_status text NOT NULL DEFAULT 'PROPOSED'
    CHECK (review_status IN ('PROPOSED','APPROVED','CHANGES_REQUESTED')),
  ADD COLUMN reviewed_by_principal_id text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text,
  ADD COLUMN base_approved_revision integer NOT NULL DEFAULT 0;

CREATE TABLE project_knowledge_heads (
  organization_id text NOT NULL,
  project_id text NOT NULL,
  approved_snapshot_id text NOT NULL REFERENCES project_knowledge_snapshots(id),
  approved_revision integer NOT NULL,
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)
);
