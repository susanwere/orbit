import { describe, expect, it } from "vitest";
import { WhyProvenanceQuery } from "../src/modules/provenance/why-provenance-query.js";
const decision = {
  id: "d1", source_artifact_id: "source1", title: "Use Load More",
  status: "ACTIVE", supersedes_decision_id: null, superseded_by_decision_id: null,
};
const source = {
  id: "source1", type: "pull_request_comment", title: "PR discussion",
  url: "https://github.com/acme/jobs/pull/5#issuecomment-1",
  metadata: { workItemArtifactId: "work1" },
};
class FakeDb {
  async query(sql: string, params: unknown[]) {
    if (sql.includes("FROM decisions WHERE") && sql.includes("id = $3")) {
      return { rows: params[2] === "d1" ? [decision] : [] };
    }
    if (sql.includes("FROM intents")) return { rows: [{ id: "intent1", statement: "Build jobs" }] };
    if (sql.includes("FROM source_artifacts") && sql.includes("type = 'work_item'")) {
      return { rows: [{ id: "work1", title: "Jobs list", type: "work_item",
        url: "https://linear.app/issue/1", metadata: {} }] };
    }
    if (sql.includes("FROM source_artifacts") && sql.includes("type = 'release'")) return { rows: [] };
    if (sql.includes("FROM source_artifacts")) return { rows: [source] };
    if (sql.includes("FROM context_versions")) return { rows: [{ id: "v4", version_number: 4 }] };
    if (sql.includes("FROM agent_sessions")) return { rows: [{
      id: "session1", mission: "Implement jobs", state: "COMPLETED",
      source_context_version_id: "v4",
    }] };
    if (sql.includes("FROM evidence")) return { rows: [{
      id: "ev1", title: "CI passed", result: "PASSED", artifact_ref: null,
      agent_session_id: "session1", scope_type: "session", scope_id: "session1",
    }] };
    return { rows: [] };
  }
}
class FakeAuthorization {
  async authorize(principal: string, project: string) {
    if (principal !== "reader" || project !== "p1") throw new Error("forbidden");
    return { organizationId: "org1" };
  }
}
describe("Why? provenance graph", () => {
  const query = new WhyProvenanceQuery(new FakeDb() as never, new FakeAuthorization() as never);
  it("traces only explicit connections from work item to CI evidence", async () => {
    const graph = await query.get("reader", "p1", "d1");
    expect(graph.nodes.map((n) => n.stage)).toEqual(expect.arrayContaining([
      "intent", "work_item", "pull_request", "decision",
      "context_version", "agent_session", "ci_evidence",
    ]));
    expect(graph.links).toContainEqual({
      from: "artifact:work1", to: "artifact:source1", relation: "explicit work-item reference",
    });
    expect(graph.missingStages).toContain("release");
  });
  it("does not pretend that a missing decision exists", async () => {
    await expect(query.get("reader", "p1", "unknown")).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("does not expose cross-project provenance", async () => {
    await expect(query.get("reader", "other", "d1")).rejects.toThrow("forbidden");
  });
});
