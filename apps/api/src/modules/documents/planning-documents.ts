import { createHash } from "node:crypto";
import type { SqlDatabase } from "@orbit/db";
import type { DocumentStorage } from "./document-storage.js";

const PER_DOCUMENT_LIMIT = 8_000;
const TOTAL_LIMIT = 24_000;
const MAX_DOCUMENTS = 10;

export interface PlanningDocument {
  id: string;
  version: number;
  filename: string;
  sha256: string;
  excerpt: string;
}

interface SourceRow extends Record<string, unknown> {
  id: string;
  version: number;
  original_filename: string;
  media_type: string;
  storage_key: string;
  sha256: string;
}

export async function extractDocumentText(mediaType: string, bytes: Buffer): Promise<string> {
  if (bytes.length > 5 * 1024 * 1024) throw new Error("Document exceeds extraction limit.");
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  }
  if (mediaType === "application/pdf") {
    const module = await import("pdf-parse");
    const parsePdf = module.default;
    const result = await parsePdf(bytes, { max: 100 });
    return result.text.replace(/\r\n?/g, "\n").trim();
  }
  if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value.replace(/\r\n?/g, "\n").trim();
  }
  throw new Error("Unsupported document type.");
}

/** Only documents attached to the project's original intent are eligible. */
export async function loadPlanningDocuments(
  db: SqlDatabase,
  storage: DocumentStorage,
  organizationId: string,
  projectId: string,
  intentId: string,
): Promise<readonly PlanningDocument[]> {
  const result = await db.query<SourceRow>(
    `SELECT d.id,a.document_version AS version,d.original_filename,d.media_type,d.storage_key,d.sha256
     FROM intent_document_attachments a
     JOIN project_documents d ON d.id=a.document_id AND d.project_id=a.project_id
     WHERE a.organization_id=$1 AND a.project_id=$2 AND a.intent_id=$3
     ORDER BY a.attached_at ASC,d.id ASC LIMIT $4`,
    [organizationId, projectId, intentId, MAX_DOCUMENTS],
  );
  const documents: PlanningDocument[] = [];
  let remaining = TOTAL_LIMIT;
  for (const row of result.rows) {
    if (remaining <= 0) break;
    const bytes = await storage.get(row.storage_key);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      throw new Error("Stored document integrity check failed.");
    const text = await extractDocumentText(row.media_type, bytes);
    const excerpt = text.slice(0, Math.min(PER_DOCUMENT_LIMIT, remaining));
    if (!excerpt) continue;
    documents.push({
      id: row.id,
      version: row.version,
      filename: row.original_filename,
      sha256: row.sha256,
      excerpt,
    });
    remaining -= excerpt.length;
  }
  return documents;
}
