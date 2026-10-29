import { describe, expect, it } from "vitest";
import {
  DomainError,
  type ContextChangeProposal,
  type ContextVersion,
  type DecisionProposal,
  type ProjectContextHead,
} from "@orbit/domain";
import { DecisionReviewService } from "../src/modules/decisions/decision-review-service.js";
import type {
  DecisionPromotionPort,
  PromoteDecisionInput,
  PromoteDecisionResult,
} from "../src/modules/decisions/decision-promotion-port.js";

const now = "2026-10-28T10:00:00.000Z";

const decision: DecisionProposal = {
  id: "dp_1",
  organizationId: "org_1",
  projectId: "project_1",
  sourceArtifactId: "artifact_1",
  sourceQuote: "use explicit Load More",
  title: "Use explicit Load More",
  rationale: "Keep loading user controlled.",
  alternatives: ["Infinite scroll"],
  scope: ["jobs list"],
  confidence: 0.95,
  baseContextVersionId: "context_v3",
  status: "READY_FOR_REVIEW",
  detectedByPrincipalId: "agent_detector",
  createdAt: now,
  updatedAt: now,
};

const change: ContextChangeProposal = {
  id: "ccp_1",
  organizationId: "org_1",
  projectId: "project_1",
  decisionProposalId: "dp_1",
  baseContextVersionId: "context_v3",
  revision: 1,
  operations: [],
  resultingContextPreview: {
    projectId: "project_1",
    originalIntentId: "intent_1",
    currentIntent: "Build jobs",
    constraints: [],
    attributes: {},
  },
  status: "READY_FOR_REVIEW",
  createdAt: now,
  updatedAt: now,
};

class FakeAuthorization {
  async authorize(principalId: string, projectId: string, _permission: string) {
    if (principalId === "viewer") throw new DomainError("forbidden", "no");
    return { principalId, organizationId: "org_1", projectId, role: "member" as const };
  }
}

class FakeReviewRepository {
  rejected = false;
  async getBundle() {
    return { decisionProposal: decision, contextChangeProposal: change };
  }
  async updateDecisionReviewFields() {
    return decision;
  }
  async reject() {
    this.rejected = true;
  }
}

class FakeContextVersions {
  head: ProjectContextHead = {
    organizationId: "org_1",
    projectId: "project_1",
    currentContextVersionId: "context_v3",
    versionNumber: 3,
    updatedAt: now,
  };
  async getHead() {
    return this.head;
  }
  async getById(): Promise<ContextVersion | null> {
    return null;
  }
}

class FakeContextChanges {
  async create(value: ContextChangeProposal) {
    return value;
  }
}

class FakePromotion implements DecisionPromotionPort {
  input?: PromoteDecisionInput;
  async promote(input: PromoteDecisionInput): Promise<PromoteDecisionResult> {
    this.input = input;
    return { decisionId: "decision_1", contextVersionId: "context_v4", versionNumber: 4 };
  }
}

function service(promotion = new FakePromotion()) {
  return {
    promotion,
    value: new DecisionReviewService(
      new FakeAuthorization() as never,
      new FakeReviewRepository() as never,
      new FakeContextVersions() as never,
      new FakeContextChanges() as never,
      promotion,
      () => "id",
      () => now,
    ),
  };
}

describe("DecisionReviewService", () => {
  it("authorizes and delegates approval without mutating context itself", async () => {
    const { value, promotion } = service();
    const result = await value.approve("usr_1", "project_1", "dp_1", "context_v3");

    expect(result.versionNumber).toBe(4);
    expect(promotion.input).toMatchObject({
      decisionProposalId: "dp_1",
      contextChangeProposalId: "ccp_1",
      expectedContextVersionId: "context_v3",
      approvedByPrincipalId: "usr_1",
    });
  });

  it("rejects stale expected context before promotion", async () => {
    const { value, promotion } = service();

    await expect(value.approve("usr_1", "project_1", "dp_1", "context_v2")).rejects.toMatchObject({
      code: "stale_context_version",
    });
    expect(promotion.input).toBeUndefined();
  });

  it("rejects proposal without context mutation", async () => {
    const review = new FakeReviewRepository();
    const promotion = new FakePromotion();
    const value = new DecisionReviewService(
      new FakeAuthorization() as never,
      review as never,
      new FakeContextVersions() as never,
      new FakeContextChanges() as never,
      promotion,
      () => "id",
      () => now,
    );

    await value.reject("usr_1", "project_1", "dp_1", "context_v3");
    expect(review.rejected).toBe(true);
    expect(promotion.input).toBeUndefined();
  });

  it("rejects unauthorized reviewers", async () => {
    const { value } = service();
    await expect(value.approve("viewer", "project_1", "dp_1", "context_v3")).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});
