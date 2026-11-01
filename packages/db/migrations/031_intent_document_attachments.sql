-- Snapshot the exact immutable source documents attached to an original intent.
CREATE TABLE intent_document_attachments (
  intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id, document_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, document_id) REFERENCES project_documents(project_id, id)
);
CREATE INDEX idx_intent_document_attachments_project ON intent_document_attachments (organization_id, project_id, intent_id);
