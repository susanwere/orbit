import type { SqlDatabase } from "@orbit/db";
import type { StructuredJsonClient } from "../decisions/meta-model-client.js";
import type { DocumentStorage } from "../documents/document-storage.js";
import { generateProjectKnowledgeSnapshot } from "./project-knowledge-routes.js";

interface RefreshJob extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  repository_full_name: string;
  merge_commit_sha: string;
  pull_number: number;
  attempts: number;
}

/** Replays durable merge-driven refreshes; never approves their output. */
export class ProjectKnowledgeRefreshWorker {
  constructor(
    private readonly db: SqlDatabase,
    private readonly storage: DocumentStorage,
    private readonly model: StructuredJsonClient,
    private readonly principalId: string,
    private readonly githubToken?: string,
  ) {}

  async processBatch(limit = 2): Promise<number> {
    let count = 0;
    for (let i = 0; i < Math.min(limit, 10); i++) {
      const job = await this.db.transaction(async (tx) => {
        const claimed = await tx.query<RefreshJob>(
          `SELECT * FROM project_knowledge_refresh_jobs
           WHERE (status IN ('PENDING','FAILED') AND next_attempt_at <= now() AND attempts < 5)
              OR (status='RUNNING' AND claimed_at < now() - interval '10 minutes' AND attempts < 5)
           ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const row = claimed.rows[0];
        if (!row) return null;
        await tx.query(
          "UPDATE project_knowledge_refresh_jobs SET status='RUNNING',claimed_at=now(),attempts=attempts+1 WHERE id=$1",
          [row.id],
        );
        return row;
      });
      if (!job) break;
      try {
        const snapshot = await generateProjectKnowledgeSnapshot(
          { db: this.db, storage: this.storage, model: this.model, githubToken: this.githubToken },
          job.organization_id,
          job.project_id,
          this.principalId,
          {
            kind: "github_merge",
            repository: job.repository_full_name,
            commitSha: job.merge_commit_sha,
            pullNumber: job.pull_number,
          },
        );
        await this.db.query(
          "UPDATE project_knowledge_refresh_jobs SET status='COMPLETED',generated_snapshot_id=$2,last_error=NULL WHERE id=$1",
          [job.id, snapshot.id],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown knowledge refresh error";
        await this.db.query(
          `UPDATE project_knowledge_refresh_jobs
           SET status='FAILED',last_error=$2,next_attempt_at=now()+($3 * interval '1 second')
           WHERE id=$1`,
          [job.id, message.slice(0, 500), Math.min(300, 2 ** job.attempts)],
        );
      }
      count++;
    }
    return count;
  }
}
