import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { DocumentStorage } from "./document-storage.js";

const MAX_BYTES = 5 * 1024 * 1024;
const allowed = new Map([
  ["text/plain", [".txt", ".md"]],
  ["text/markdown", [".md"]],
  ["application/pdf", [".pdf"]],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
]);

interface DocumentRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  organization_id: string;
  original_filename: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  processing_status: string;
  version: number;
  created_at: string;
}

export interface ProjectDocumentRouteOptions {
  db: SqlDatabase;
  auth: AuthVerifier;
  authorization: ProjectAuthorizationService;
  storage: DocumentStorage;
}

export function decodeDocumentUpload(input: unknown): {
  filename: string;
  mediaType: string;
  contents: Buffer;
  sha256: string;
} {
  const data = input as Record<string, unknown> | null;
  const filename = data?.filename;
  const mediaType = data?.mediaType;
  const base64 = data?.base64;
  if (
    typeof filename !== "string" ||
    filename.length < 1 ||
    filename.length > 255 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    typeof mediaType !== "string" ||
    typeof base64 !== "string" ||
    !allowed.has(mediaType)
  )
    throw new DomainError("validation", "Invalid filename or unsupported document type.");
  const extensions = allowed.get(mediaType)!;
  if (!extensions.some((suffix) => filename.toLowerCase().endsWith(suffix)))
    throw new DomainError("validation", "The document extension does not match its media type.");
  if (base64.length > Math.ceil(MAX_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
    throw new DomainError("validation", "Document encoding or size is invalid.");
  const contents = Buffer.from(base64, "base64");
  if (!contents.length || contents.length > MAX_BYTES)
    throw new DomainError("validation", "Document must be between 1 byte and 5 MB.");
  // Avoid trusting the caller's filename/media type alone for binary formats.
  if (mediaType === "application/pdf" && !contents.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw new DomainError("validation", "Invalid PDF signature.");
  if (filename.toLowerCase().endsWith(".docx") && !contents.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04])))
    throw new DomainError("validation", "Invalid DOCX container signature.");
  if (mediaType.startsWith("text/") && contents.includes(0))
    throw new DomainError("validation", "Invalid text document.");
  return { filename, mediaType, contents, sha256: createHash("sha256").update(contents).digest("hex") };
}

export async function registerProjectDocumentRoutes(
  app: FastifyInstance,
  options: ProjectDocumentRouteOptions,
) {
  const { db, auth, authorization, storage } = options;
  const access = async (header: string | undefined, projectId: string, permission: "read" | "review") => {
    const principal = auth.verify(header);
    const actor = await authorization.authorize(principal.id, projectId, permission);
    return { principal, actor };
  };
  const projection = "id,project_id,organization_id,original_filename,media_type,size_bytes,sha256,processing_status,version,created_at";

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/projects/:projectId/documents",
    { bodyLimit: 7 * 1024 * 1024 + 16384 },
    async (request, reply) => {
      const projectId = request.params.projectId;
      const { principal, actor } = await access(request.headers.authorization, projectId, "review");
      const uploaded = decodeDocumentUpload(request.body);
      const key = await storage.put(uploaded.contents);
      try {
        const stored = await db.query<DocumentRow>(
          `INSERT INTO project_documents
           (id,project_id,organization_id,uploaded_by_principal_id,original_filename,media_type,size_bytes,sha256,storage_key)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${projection}`,
          [randomUUID(), projectId, actor.organizationId, principal.id, uploaded.filename,
            uploaded.mediaType, uploaded.contents.length, uploaded.sha256, key],
        );
        return reply.status(201).send(stored.rows[0]);
      } catch (error) {
        await storage.remove(key).catch(() => undefined);
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/documents",
    async (request) => {
      const { actor } = await access(request.headers.authorization, request.params.projectId, "read");
      const result = await db.query<DocumentRow>(
        `SELECT ${projection} FROM project_documents
         WHERE project_id=$1 AND organization_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,
        [request.params.projectId, actor.organizationId],
      );
      return { documents: result.rows };
    },
  );

  app.get<{ Params: { projectId: string; documentId: string } }>(
    "/projects/:projectId/documents/:documentId",
    async (request) => {
      const { actor } = await access(request.headers.authorization, request.params.projectId, "read");
      const result = await db.query<DocumentRow>(
        `SELECT ${projection} FROM project_documents
         WHERE project_id=$1 AND organization_id=$2 AND id=$3`,
        [request.params.projectId, actor.organizationId, request.params.documentId],
      );
      if (!result.rows[0]) throw new DomainError("not_found", "Document not found.");
      return result.rows[0];
    },
  );
}
