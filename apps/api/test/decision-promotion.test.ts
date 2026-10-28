import { describe, expect, it } from "vitest";
import type {
  ProjectContextPreview,
} from "@orbit/domain";
import {
  materializeApprovedContext,
} from "../src/modules/decisions/postgres-decision-promotion.js";

const now = "2026-10-28T10:00:00.000Z";

describe("Decision promotion context materialization", () => {
  it("converts proposed constraint provenance to the authoritative Decision", () => {
    const preview: ProjectContextPreview = {
      projectId: "project_1",
      originalIntentId: "intent_1",
      currentIntent: "Build jobs",
      constraints: [
        {
          id: "existing",
          key: "api",
          statement: "Use HN API",
          sourceDecisionId: "decision_existing",
          createdAt: now,
        },
        {
          id: "proposed",
          key: "pagination",
          statement: "Use Load More",
          sourceDecisionProposalId: "dp_1",
          createdAt: now,
        },
      ],
      attributes: {},
    };

    const context = materializeApprovedContext(
      preview,
      "dp_1",
      "decision_1",
    );

    expect(context.constraints[0]).toMatchObject({
      sourceDecisionId: "decision_existing",
    });
    expect(context.constraints[1]).toEqual({
      id: "proposed",
      key: "pagination",
      statement: "Use Load More",
      sourceDecisionId: "decision_1",
      createdAt: now,
    });
    expect("sourceDecisionProposalId" in context.constraints[1]!).toBe(false);
  });

  it("rejects preview constraints belonging to a different proposal", () => {
    const preview: ProjectContextPreview = {
      projectId: "project_1",
      originalIntentId: "intent_1",
      currentIntent: "Build jobs",
      constraints: [
        {
          id: "foreign",
          key: "pagination",
          statement: "Use Load More",
          sourceDecisionProposalId: "dp_other",
          createdAt: now,
        },
      ],
      attributes: {},
    };

    expect(() =>
      materializeApprovedContext(preview, "dp_1", "decision_1"),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_context_preview" }),
    );
  });
});
