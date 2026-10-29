import { describe, expect, it, vi } from "vitest";
import {
  MuseWorkGraphPlanner,
  validateProposedWorkGraph,
} from "../src/modules/planning/muse-work-graph-planner.js";

const valid = {
  summary: "Build consent-first interview capture.",
  workItems: [
    {
      key: "REC-1",
      title: "Implement recorder controls",
      description: "Explicit consent and visible stop controls",
      dependsOn: [],
      workflows: [
        {
          name: "Requirements",
          steps: [
            { title: "Review consent requirements", executor: "human", requiresApproval: true },
          ],
        },
        {
          name: "Engineering",
          steps: [
            { title: "Implement recorder", executor: "agent", requiresApproval: false },
            { title: "Approve API contract", executor: "human", requiresApproval: true },
          ],
        },
      ],
    },
    {
      key: "REC-2",
      title: "Transcription",
      description: "Asynchronous transcription",
      dependsOn: ["REC-1"],
      workflows: [
        {
          name: "Quality",
          steps: [{ title: "Test capture", executor: "system", requiresApproval: false }],
        },
      ],
    },
  ],
  guardrails: ["Explicit recording consent"],
  decisionsToReview: ["Retention period"],
  assumptions: ["Audio APIs are available"],
};

describe("Muse work graph planning", () => {
  it("validates a real multi-workflow proposal and dependencies", () => {
    const result = validateProposedWorkGraph(valid);
    expect(result.workItems[0]?.workflows).toHaveLength(2);
    expect(result.workItems[1]?.dependsOn).toEqual(["REC-1"]);
  });

  it("rejects duplicate and cyclic dependencies and unknown executors", () => {
    const copy = () => structuredClone(valid);
    const duplicated = copy();
    duplicated.workItems[1]!.key = "REC-1";
    expect(() => validateProposedWorkGraph(duplicated)).toThrow();
    const cycle = copy();
    cycle.workItems[0]!.dependsOn = ["REC-2"];
    expect(() => validateProposedWorkGraph(cycle)).toThrow();
    const invalidExecutor = copy();
    invalidExecutor.workItems[0]!.workflows[0]!.steps[0]!.executor = "untrusted";
    expect(() => validateProposedWorkGraph(invalidExecutor)).toThrow();
    const externalDependency = copy();
    externalDependency.workItems[1]!.dependsOn = ["OUTSIDE-ORG"];
    expect(() => validateProposedWorkGraph(externalDependency)).toThrow();
  });

  it("calls Muse Spark once with bounded context, not tool actions", async () => {
    const complete = vi.fn().mockResolvedValue(valid);
    const planner = new MuseWorkGraphPlanner({ complete });
    const result = await planner.propose({
      originalIntent: "Build an interview capture app",
      knownDecisions: ["Explicit consent"],
      knownConstraints: ["No meeting bot"],
    });
    expect(result.summary).toBe(valid.summary);
    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]![0];
    expect(request.model).toBe("muse-spark-1.3");
    expect(JSON.parse(request.userPrompt)).toEqual({
      originalIntent: "Build an interview capture app",
      knownDecisions: ["Explicit consent"],
      knownConstraints: ["No meeting bot"],
    });
    expect(request.systemPrompt).toContain("never execute");
  });

  it("does not issue a model call for invalid intent", async () => {
    const complete = vi.fn();
    const planner = new MuseWorkGraphPlanner({ complete });
    await expect(
      planner.propose({
        originalIntent: " ",
        knownDecisions: [],
        knownConstraints: [],
      }),
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});
