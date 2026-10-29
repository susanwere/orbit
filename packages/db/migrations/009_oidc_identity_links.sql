-- External identities are explicitly linked to pre-existing human principals.
-- Never infer an organization from a browser-supplied field.
CREATE TABLE principal_oidc_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject),
  UNIQUE (issuer, principal_id)
);
