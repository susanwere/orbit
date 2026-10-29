import { describe, expect, it } from "vitest";
import {
  DomainError,
  type ContextChangeOperation,
  type ContextVersion,
  type ProjectContext,
} from "@orbit/domain";
import { applyContextChangeOperations } from "../src/modules/context/context-mutation.js";
import { generateContextChangeProposal } from "../src/modules/context/context-change-generator.js";

const now = "2026-10-28T10:00:00.000Z";

function baseContext(): ProjectContext {
  return {
    projectId: "project_1",
    originalIntentId: "intent_1",
    currentIntent: "Build a responsive jobs viewer.",
    constraints: [
      {
        id: "constraint_existing",
        key: "api.provider",
        statement: "Use the Hacker News public API.",
        sourceDecisionId: "decision_existing",
        createdAt: now,
      },
    ],
    attributes: {
      releaseChannel: "preview",
    },
  };
}

function baseVersion(): ContextVersion {
  return {
    id: "context_v3",
    organizationId: "org_1",
    projectId: "project_1",
    versionNumber: 3,
    content: baseContext(),
    contentHash: "a".repeat(64),
    createdAt: now,
  };
}

const candidate = {
  confidence: 0.94,
  title: "Use explicit Load More with batches of 20 jobs",
  rationale: "Keep initial loading fast and user controlled.",
  alternatives: ["Infinite scroll"],
  scope: ["jobs list"],
  evidenceQuote: "use explicit Load More",
};

describe("Context Change Proposal generation", () => {
  it("creates an exact reviewable constraint mutation against the base version", () => {
    const proposal = generateContextChangeProposal({
      id: "change_1",
      organizationId: "org_1",
      projectId: "project_1",
      decisionProposalId: "proposal_1",
      baseContextVersion: baseVersion(),
      candidate,
      createdAt: now,
    });

    expect(proposal.baseContextVersionId).toBe("context_v3");
    expect(proposal.revision).toBe(1);
    expect(proposal.status).toBe("READY_FOR_REVIEW");
    expect(proposal.operations).toEqual([
      {
        op: "add",
        path: "/constraints/-",
        value: {
          id: "constraint_proposed_proposal_1",
          key: "decision.proposal_1",
          statement: "Use explicit Load More with batches of 20 jobs",
          sourceDecisionProposalId: "proposal_1",
          createdAt: now,
        },
      },
    ]);
    expect(proposal.resultingContextPreview.constraints).toHaveLength(2);
    expect(proposal.resultingContextPreview.constraints[1]).toMatchObject({
      sourceDecisionProposalId: "proposal_1",
      statement: "Use explicit Load More with batches of 20 jobs",
    });

    // Generation does not mutate authoritative base context.
    expect(baseVersion().content.constraints).toHaveLength(1);
  });

  it("rejects mutation paths outside the allowlist", () => {
    const operation: ContextChangeOperation = {
      op: "replace",
      path: "/projectId",
      value: "other-project",
    };

    expect(() =>
      applyContextChangeOperations(baseContext(), [operation], ["/projectId"]),
    ).toThrowError(
      expect.objectContaining({
        code: "immutable_context_path",
      }),
    );
  });

  it("rejects allowed-path escapes", () => {
    const operation: ContextChangeOperation = {
      op: "replace",
      path: "/attributes/secret",
      value: "leak",
    };

    try {
      applyContextChangeOperations(baseContext(), [operation], ["/constraints/-"]);
      throw new Error("Expected path policy rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("context_path_not_allowed");
    }
  });

  it("supports deterministic allowed attribute updates without mutating the base", () => {
    const original = baseContext();
    const preview = applyContextChangeOperations(
      original,
      [
        {
          op: "replace",
          path: "/attributes/releaseChannel",
          value: "production",
        },
      ],
      ["/attributes/**"],
    );

    expect(preview.attributes.releaseChannel).toBe("production");
    expect(original.attributes.releaseChannel).toBe("preview");
  });

  it("rejects prototype-pollution paths even when broadly allowed", () => {
    expect(() =>
      applyContextChangeOperations(
        baseContext(),
        [
          {
            op: "add",
            path: "/attributes/__proto__/polluted",
            value: true,
          },
        ],
        ["/attributes/**"],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_context_path",
      }),
    );
  });

  it("rejects a base ContextVersion from another project", () => {
    expect(() =>
      generateContextChangeProposal({
        id: "change_1",
        organizationId: "org_1",
        projectId: "project_2",
        decisionProposalId: "proposal_1",
        baseContextVersion: baseVersion(),
        candidate,
        createdAt: now,
      }),
    ).toThrow(DomainError);
  });
});
