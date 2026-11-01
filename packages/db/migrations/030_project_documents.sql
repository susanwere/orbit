-- Immutable, tenant-scoped source document metadata. Binary objects are stored outside PostgreSQL.
CREATE TABLE project_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  uploaded_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  processing_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (processing_status IN ('PENDING','READY','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, uploaded_by_principal_id)
    REFERENCES principals(organization_id, id)
);
CREATE INDEX idx_project_documents_scope
  ON project_documents (organization_id, project_id, created_at DESC, id DESC);
