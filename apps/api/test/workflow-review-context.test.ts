import { describe, expect, it } from "vitest";
import type { WorkflowReviewContext } from "@orbit/domain";
import { missionWithWorkflowContext } from "../src/modules/context/workflow-review-context.js";

import { assertContextOperationAllowed } from "../src/modules/context/context-mutation.js";

const approvedReview = (index: number, comment: string): WorkflowReviewContext => ({
  evidenceId: `evidence-${index}`,
  stepId: `step-${index}`,
  planId: "approved-plan",
  planRevision: 2,
  workItemKey: `workflow-${index}`,
  workflowIndex: index,
  stepIndex: 0,
  stepTitle: "Review wording",
  approvedByPrincipalId: "reviewer",
  approvedAt: `2026-11-01T10:00:0${index}.000Z`,
  comment,
  proposal: {
    jobId: `job-${index}`,
    contentHash: `hash-${index}`,
    source: "execution",
    content: index === 0 ? "Hello, Hallo, Jambo. No labels." : "Keep approved wording.",
  },
});

describe("approved project workflow instructions", () => {
  it("prevents generic context edits from forging approval history", () => {
    expect(() =>
      assertContextOperationAllowed({ op: "add", path: "/workflowReviews", value: [] }, [
        "/workflowReviews",
      ]),
    ).toThrowError(expect.objectContaining({ code: "immutable_context_path" }));
  });
  it("retains full proposals and early decisions across more than three workflow approvals", () => {
    const mission = missionWithWorkflowContext("Implement the greeting", [
      approvedReview(0, "Add ! after each word"),
      approvedReview(1, "Auto-rotate every two seconds"),
      approvedReview(2, ""),
      approvedReview(3, "LGTM"),
      approvedReview(4, ""),
    ]);
    expect(mission).toContain("Hello, Hallo, Jambo. No labels.");
    expect(mission).toContain("Add ! after each word");
    expect(mission).toContain("Auto-rotate every two seconds");
    expect(mission).toContain('"evidenceId":"evidence-4"');
    expect(mission).toContain('"approvedComment":null');
    expect(mission).toContain('"proposalHash":"hash-0"');
  });
  it("fails explicitly instead of silently truncating approved choices", () => {
    expect(() =>
      missionWithWorkflowContext("Execute", [approvedReview(0, "x".repeat(12000))]),
    ).toThrow("No decisions were omitted");
  });
  it("preserves missions with no reviewed context", () => {
    expect(missionWithWorkflowContext("Draft options", [])).toBe("Draft options");
  });
});
