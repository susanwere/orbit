# Intent supporting documents: storage foundation

This PR introduces the **first backend-only slice** of project documents.

## Local development

Set `ORBIT_DOCUMENT_STORAGE_DIR` to a **private, non-web-served directory** outside the repository, and run database migrations before starting the API. Without this variable the document routes are **not registered**. Do not configure this local adapter for multi-instance production deployments; use a shared private object-store adapter (e.g. S3) before shipping to production.

## Routes

All routes require the existing Bearer auth and project-scoped authorization:

- `POST /projects/:projectId/documents` (review permission): JSON `{ "filename": "README.md", "mediaType": "text/markdown", "base64": "IyBIZWxsbyE=" }`.
- `GET /projects/:projectId/documents` (read): latest 100 metadata records.
- `GET /projects/:projectId/documents/:documentId` (read): one scoped metadata record.

This API intentionally **does not return file bytes or storage paths**. Max upload size 5 MiB; the JSON request limit is bounded; file extensions and signatures are checked, but a production ingestion pipeline will need stronger content scanning and archive validation. Uploaded original files are never executed, and uploads don't trigger model calls or context mutations.

## Follow-up PRs required for the complete feature

1. Production-ready private object storage, malware/content scanning, stricter DOCX/PDF validation, secured download and cleanup/lifecycle handling.
2. Intent-to-document-version association and multi-file upload UI.
3. Document extraction and reusable Project Context library.
4. Bounded, source-attributed Muse Spark planning context assembly.
5. Reviewed, immutable context-change proposals after verified implementations.

**No existing Intent, Muse, approval, worker, GitHub delivery or CI behavior is changed by this PR.**
