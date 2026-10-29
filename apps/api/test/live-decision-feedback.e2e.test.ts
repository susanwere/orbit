import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import type { AgentDefinition } from "@orbit/domain";
import { buildApp } from "../src/app.js";
import { hashProjectContext } from "../src/modules/context/canonical-context.js";
import { GithubWebhookWorker } from "../src/modules/integrations/github/webhook-worker.js";
import { PostgresWebhookInboxStore } from "../src/modules/integrations/github/webhook-inbox.js";
import { DecisionAnalysisService } from "../src/modules/decisions/decision-analysis-service.js";
import { DecisionAnalysisWorker } from "../src/modules/decisions/decision-analysis-worker.js";
import { ProjectAuthorizationService } from "../src/modules/projects/project-authorization.js";
import { DecisionReviewService } from "../src/modules/decisions/decision-review-service.js";
import { DecisionReviewRepository } from "../src/modules/decisions/decision-review-repository.js";
import { ContextChangeProposalRepository } from "../src/modules/context/context-change-proposal-repository.js";
import { ContextVersionRepository } from "../src/modules/context/context-version-repository.js";
import { PostgresDecisionPromotion } from "../src/modules/decisions/postgres-decision-promotion.js";
import { NoopDomainEventPublisher } from "../src/modules/events/domain-event-publisher.js";
import { AgentContextSnapshotService } from "../src/modules/context/agent-context-snapshot-service.js";
import { ProjectEventStream } from "../src/modules/events/project-event-stream.js";

const url = process.env.TEST_DATABASE_URL;
const secret = "e2e-github-secret";
describe.skipIf(!url)("signed webhook to authoritative context V1 end-to-end", () => {
  let db: PgDatabase;
  const key = randomUUID();
  const organizationId = `org_live_${key}`;
  const projectId = `project_live_${key}`;
  const human = `human_live_${key}`;
  const system = `system_live_${key}`;
  const originalIntentId = `intent_live_${key}`;
  const v3 = `context_live_${key}`;
  const original = "Build the Hacker News jobs viewer";
  const decisionText =
    "Fetch 20 jobs initially and use explicit Load More rather than infinite scroll";
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    db = new PgDatabase(url!);
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Live Feedback')", [
      organizationId,
    ]);
    await db.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'HN Jobs')", [
      projectId,
      organizationId,
    ]);
    await db.query(
      "INSERT INTO principals(id,organization_id,type,display_name,role) VALUES($1,$2,'human','Reviewer','admin')",
      [human, organizationId],
    );
    await db.query(
      "INSERT INTO principals(id,organization_id,type,display_name) VALUES($1,$2,'system','Detector')",
      [system, organizationId],
    );
    await db.query(
      `INSERT INTO intents(id,organization_id,project_id,statement,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5)`,
      [originalIntentId, organizationId, projectId, original, human],
    );
    const content = {
      projectId,
      originalIntentId,
      currentIntent: original,
      constraints: [],
      attributes: {},
    };
    await db.query(
      `INSERT INTO context_versions(id,organization_id,project_id,version_number,content,content_hash)
      VALUES($1,$2,$3,3,$4::jsonb,$5)`,
      [v3, organizationId, projectId, JSON.stringify(content), hashProjectContext(content)],
    );
    await db.query(
      `INSERT INTO project_context_heads(project_id,organization_id,current_context_version_id,version_number)
      VALUES($1,$2,$3,3)`,
      [projectId, organizationId, v3],
    );
    const authorization = new ProjectAuthorizationService(db);
    const auth = {
      verify: (header: string | undefined) => {
        if (header !== "Bearer e2e-reviewer") throw new Error("Invalid test token");
        return { id: human, organizationId };
      },
    };
    const review = new DecisionReviewService(
      authorization,
      new DecisionReviewRepository(db),
      new ContextVersionRepository(db),
      new ContextChangeProposalRepository(db),
      new PostgresDecisionPromotion(db, new NoopDomainEventPublisher()),
    );
    app = await buildApp({
      githubWebhook: {
        secret,
        organizationId,
        projectId,
        inbox: new PostgresWebhookInboxStore(db),
      },
      auth,
      decisionReview: review,
      projectReads: { db, auth, authorization },
      notifications: { db, auth, authorization },
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await db.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
      await db.close();
    }
  });

  it("verifies, normalizes, proposes, notifies, approves and propagates exactly once", async () => {
    const deliveryId = `delivery-${key}`;
    const raw = JSON.stringify({
      action: "created",
      repository: { full_name: "demo/hn-jobs" },
      issue: { number: 42, pull_request: {} },
      comment: {
        id: 107,
        body: decisionText,
        created_at: "2026-10-28T12:00:00Z",
        html_url: "https://github.com/demo/hn-jobs/pull/42#issuecomment-107",
      },
      sender: { id: 7, login: "maintainer", type: "User" },
    });
    const sig = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const headers = {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "issue_comment",
      "x-hub-signature-256": sig,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/github",
          payload: raw,
          headers: { ...headers, "x-hub-signature-256": "sha256=" + "0".repeat(64) },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/webhooks/github", payload: raw, headers }))
        .statusCode,
    ).toBe(202);
    const duplicate = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: raw,
      headers,
    });
    expect(duplicate.json()).toMatchObject({ duplicate: true });
    const worker = new GithubWebhookWorker(db, projectId);
    expect(await worker.processBatch()).toBe(1);
    expect(await worker.processBatch()).toBe(0);

    let calls = 0;
    const detector = {
      detect: async () => {
        calls++;
        return {
          kind: "candidate" as const,
          candidate: {
            title: decisionText,
            rationale: "Improve initial page load",
            confidence: 0.99,
            alternatives: ["Infinite scroll"],
            scope: ["jobs"],
            evidenceQuote: decisionText,
          },
        };
      },
    };
    const analyzer = new DecisionAnalysisService(db, detector, system);
    const analysis = new DecisionAnalysisWorker(db, analyzer, projectId);
    expect(await analysis.processBatch()).toBe(1);
    expect(calls).toBe(1);
    const proposals = await db.query<{ id: string }>(
      "SELECT id FROM decision_proposals WHERE project_id=$1",
      [projectId],
    );
    expect(proposals.rows).toHaveLength(1);
    const proposalId = proposals.rows[0]!.id;
    const token = { authorization: "Bearer e2e-reviewer" };
    const attention = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/notifications`,
      headers: token,
    });
    expect(attention.statusCode).toBe(200);
    expect(attention.json().unreadCount).toBe(1);
    const review = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/decision-proposals/${proposalId}`,
      headers: token,
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().contextChangeProposal.operations).toContainEqual({
      op: "add",
      path: "/attributes/engineeringConstraints",
      value: { pagination: { mode: "load_more", batchSize: 20, infiniteScroll: false } },
    });
    const approval = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/decision-proposals/${proposalId}/approve`,
      headers: token,
      payload: { expectedContextVersionId: v3 },
    });
    expect(approval.statusCode).toBe(200);
    const promoted = approval.json() as {
      decisionId: string;
      contextVersionId: string;
      versionNumber: number;
    };
    expect(promoted.versionNumber).toBe(4);
    const current = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/context`,
      headers: token,
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().content.attributes.engineeringConstraints.pagination).toEqual({
      mode: "load_more",
      batchSize: 20,
      infiniteScroll: false,
    });
    const base = await db.query<{ content: { currentIntent: string } }>(
      "SELECT content FROM context_versions WHERE id=$1",
      [v3],
    );
    expect(base.rows[0]?.content.currentIntent).toBe(original);
    const events = await new ProjectEventStream(db).read(projectId, null);
    expect(events.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "pull_request.comment_created",
        "decision.review_required",
        "context.updated",
      ]),
    );
    const outbox = await db.query<{ status: string }>(
      "SELECT status FROM domain_effect_jobs WHERE project_id=$1",
      [projectId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]?.status).toBe("pending");

    const agent: AgentDefinition = {
      id: "agent-demo",
      organizationId,
      name: "Engineering",
      purpose: "Implement jobs",
      provider: "meta",
      model: "muse-spark-1.3",
      capabilities: ["repo.read"],
      approvedTools: [],
      maxContextClassification: "INTERNAL",
      allowedContextScopes: ["project"],
      allowedRepositories: ["demo/hn-jobs"],
      allowedPaths: ["src/**"],
      approvalRequiredActions: [],
      forbiddenActions: [],
      networkPolicy: "none",
      networkAllowlist: [],
      status: "approved",
      version: 1,
      createdByPrincipalId: human,
      createdAt: "2026-10-28T12:00:00Z",
    };
    const snapshot = await new AgentContextSnapshotService(
      db,
      new ProjectAuthorizationService(db),
    ).create({
      projectId,
      requestedByPrincipalId: human,
      agent,
      mission: "Implement jobs Load More",
    });
    expect(snapshot.sourceContextVersionId).toBe(promoted.contextVersionId);
    expect(snapshot.includedDecisionIds).toContain(promoted.decisionId);
    expect(await analysis.processBatch()).toBe(0);
    const second = await db.query<{ id: string }>("SELECT id FROM decisions WHERE project_id=$1", [
      projectId,
    ]);
    expect(second.rows).toHaveLength(1);
  });
});
