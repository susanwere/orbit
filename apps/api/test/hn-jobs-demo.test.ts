import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabase } from "@orbit/db";
import { replayHnJobsDemo } from "./fixtures/hn-jobs-demo.js";

const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)("HN Jobs deterministic demo replay", () => {
  let db: PgDatabase;
  beforeAll(() => { db = new PgDatabase(connection!); });
  afterAll(async () => {
    await db.query("DELETE FROM organizations WHERE id = 'demo_hn_org'");
    await db.close();
  });

  it("replays PR → proposal → approval → D-107 → v4 → future agent snapshot", async () => {
    const first = await replayHnJobsDemo(db);
    expect(first.decisionId).toBe("D-107");
    expect(first.decisionStatus).toBe("ACTIVE");
    expect(first.contextVersion).toBe(4);
    expect(first.currentContextVersionId).toBe("demo_context_v4");
    expect(first.futureSessionContextVersionId).toBe("demo_context_v4");
    expect(first.includedDecisionIds).toContain("D-107");
    expect(first.eventTypes).toEqual([
      "decision.accepted", "context.version_created", "context.updated",
    ]);
    expect(first.reviewedOperations).toEqual([{
      op: "add", path: "/constraints/-",
      value: {
        id: "constraint_proposed_demo_decision_proposal",
        key: "decision.demo_decision_proposal",
        statement: "Fetch 20 jobs initially and use explicit Load More rather than infinite scroll",
        sourceDecisionProposalId: "demo_decision_proposal",
        createdAt: "2026-10-28T12:00:00.000Z",
      },
    }, {
      op: "add",
      path: "/attributes/engineeringConstraints",
      value: {
        pagination: { mode:"load_more",batchSize:20,infiniteScroll:false },
      },
    }]);
    const authoritative = await db.query<{
      status: string;
      source_decision_proposal_id: string;
    }>("SELECT status, source_decision_proposal_id FROM decisions WHERE id = 'D-107'");
    expect(authoritative.rows[0]).toMatchObject({
      status: "ACTIVE",
      source_decision_proposal_id: "demo_decision_proposal",
    });
    const events = await db.query<{ type: string }>(
      "SELECT type FROM events WHERE project_id = 'demo_hn_jobs' ORDER BY occurred_at, id",
    );
    expect(events.rowCount).toBe(3);

    // Fixed timestamps and IDs produce identical replay results in a fresh tenant.
    const second = await replayHnJobsDemo(db);
    expect(second).toEqual(first);
  });
});
