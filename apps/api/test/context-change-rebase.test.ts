import { describe, expect, it } from "vitest";
import type { ContextChangeProposal, ContextVersion, ProjectContext } from "@orbit/domain";
import { rebaseContextChangeProposal } from "../src/modules/context/context-change-rebase.js";

const at = "2026-10-28T10:00:00.000Z";
const context = (): ProjectContext => ({
  projectId: "project_1",
  originalIntentId: "intent_1",
  currentIntent: "Build jobs",
  constraints: [],
  attributes: {},
});
const version = (id: string, n: number, content = context()): ContextVersion => ({
  id,
  organizationId: "org_1",
  projectId: "project_1",
  versionNumber: n,
  content,
  contentHash: "a".repeat(64),
  createdAt: at,
});
const previous: ContextChangeProposal = {
  id: "ccp_1",
  organizationId: "org_1",
  projectId: "project_1",
  decisionProposalId: "dp_1",
  baseContextVersionId: "v3",
  revision: 1,
  operations: [
    {
      op: "add",
      path: "/constraints/-",
      value: {
        id: "constraint_dp_1",
        key: "decision.dp_1",
        statement: "Use Load More",
        sourceDecisionProposalId: "dp_1",
        createdAt: at,
      },
    },
  ],
  resultingContextPreview: {
    ...context(),
    constraints: [
      {
        id: "constraint_dp_1",
        key: "decision.dp_1",
        statement: "Use Load More",
        sourceDecisionProposalId: "dp_1",
        createdAt: at,
      },
    ],
  },
  status: "READY_FOR_REVIEW",
  createdAt: at,
  updatedAt: at,
};
const rebase = (proposal = previous, current = version("v4", 4)) =>
  rebaseContextChangeProposal({
    previous: proposal,
    previousBase: version("v3", 3),
    current,
    id: "ccp_2",
    createdAt: at,
  });

describe("stale Context Change Proposal rebase", () => {
  it("creates a new reviewable revision while preserving original provenance", () => {
    const result = rebase();
    expect(result.id).toBe("ccp_2");
    expect(result.baseContextVersionId).toBe("v4");
    expect(result.revision).toBe(2);
    expect(result.status).toBe("READY_FOR_REVIEW");
    expect(result.resultingContextPreview.constraints[0]).toMatchObject({
      sourceDecisionProposalId: "dp_1",
    });
    expect(previous.baseContextVersionId).toBe("v3");
  });

  it("rejects duplicate constraint keys", () => {
    const current = version("v4", 4, {
      ...context(),
      constraints: [
        {
          id: "existing",
          key: "decision.dp_1",
          statement: "Existing",
          sourceDecisionId: "d_1",
          createdAt: at,
        },
      ],
    });
    expect(() => rebase(previous, current)).toThrowError(
      expect.objectContaining({ code: "stale_context_version" }),
    );
  });

  it("refuses non-append edits when the base changed", () => {
    const edited: ContextChangeProposal = {
      ...previous,
      operations: [{ op: "replace", path: "/currentIntent", value: "Updated" }],
    };
    expect(() =>
      rebase(
        edited,
        version("v4", 4, {
          ...context(),
          currentIntent: "Other approved change",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "stale_context_version" }));
  });

  it("does not rebase proposals that were already applied", () => {
    expect(() => rebase({ ...previous, status: "APPLIED" })).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });
});
