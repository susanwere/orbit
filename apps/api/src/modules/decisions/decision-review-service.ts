import {
  DomainError,
  type ContextChangeOperation,
  type ContextChangeProposal,
} from "@orbit/domain";
import { randomUUID } from "node:crypto";
import { ContextVersionRepository } from "../context/context-version-repository.js";
import {
  buildContextChangeRevision,
  generateContextChangeProposal,
} from "../context/context-change-generator.js";
import { ContextChangeProposalRepository } from "../context/context-change-proposal-repository.js";
import { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { DecisionPromotionPort, PromoteDecisionResult } from "./decision-promotion-port.js";
import { DecisionReviewRepository, type DecisionReviewBundle } from "./decision-review-repository.js";

export interface EditDecisionReviewInput {
  readonly title?: string;
  readonly rationale?: string;
  readonly operations?: readonly ContextChangeOperation[];
  readonly expectedContextVersionId: string;
}

export class DecisionReviewService {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly reviewRepository: DecisionReviewRepository,
    private readonly contextVersions: ContextVersionRepository,
    private readonly contextChanges: ContextChangeProposalRepository,
    private readonly promotion: DecisionPromotionPort,
    private readonly idFactory: () => string = randomUUID,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async get(
    principalId: string,
    projectId: string,
    proposalId: string,
  ): Promise<DecisionReviewBundle> {
    await this.authorization.authorize(principalId, projectId, "read");
    return this.requireBundle(projectId, proposalId);
  }

  async edit(
    principalId: string,
    projectId: string,
    proposalId: string,
    input: EditDecisionReviewInput,
  ): Promise<DecisionReviewBundle> {
    const actor = await this.authorization.authorize(principalId, projectId, "review");
    const current = await this.requireBundle(projectId, proposalId);
    await this.assertCurrentVersion(
      projectId,
      current.decisionProposal.baseContextVersionId,
      input.expectedContextVersionId,
    );

    if (
      current.decisionProposal.status !== "READY_FOR_REVIEW" ||
      current.contextChangeProposal.status !== "READY_FOR_REVIEW"
    ) {
      throw new DomainError("invalid_state", "Proposal is not editable.");
    }

    const updatedAt = this.clock();
    const decision = await this.reviewRepository.updateDecisionReviewFields(
      projectId,
      proposalId,
      {
        title: input.title?.trim() || undefined,
        rationale: input.rationale?.trim() || undefined,
        updatedAt,
      },
    );

    const base = await this.contextVersions.getById(
      projectId,
      decision.baseContextVersionId,
    );
    if (!base) {
      throw new DomainError("not_found", "Base ContextVersion not found.");
    }

    const revision = current.contextChangeProposal.revision + 1;
    const changeId = `ccp_${this.idFactory()}`;
    let change: ContextChangeProposal;

    if (input.operations) {
      change = buildContextChangeRevision({
        id: changeId,
        organizationId: actor.organizationId,
        projectId,
        decisionProposalId: decision.id,
        baseContextVersion: base,
        operations: input.operations,
        revision,
        createdAt: updatedAt,
      });
    } else {
      change = generateContextChangeProposal({
        id: changeId,
        organizationId: actor.organizationId,
        projectId,
        decisionProposalId: decision.id,
        baseContextVersion: base,
        candidate: {
          confidence: decision.confidence ?? 1,
          title: decision.title,
          rationale: decision.rationale,
          alternatives: decision.alternatives,
          scope: decision.scope,
          evidenceQuote: decision.sourceQuote ?? decision.title,
        },
        revision,
        createdAt: updatedAt,
      });
    }

    const persisted = await this.contextChanges.create(change);
    return { decisionProposal: decision, contextChangeProposal: persisted };
  }

  async approve(
    principalId: string,
    projectId: string,
    proposalId: string,
    expectedContextVersionId: string,
  ): Promise<PromoteDecisionResult> {
    const actor = await this.authorization.authorize(principalId, projectId, "review");
    const bundle = await this.requireBundle(projectId, proposalId);
    await this.assertCurrentVersion(
      projectId,
      bundle.decisionProposal.baseContextVersionId,
      expectedContextVersionId,
    );

    if (
      bundle.decisionProposal.status !== "READY_FOR_REVIEW" ||
      bundle.contextChangeProposal.status !== "READY_FOR_REVIEW"
    ) {
      throw new DomainError("invalid_state", "Proposal is not approvable.");
    }

    return this.promotion.promote({
      organizationId: actor.organizationId,
      projectId,
      decisionProposalId: bundle.decisionProposal.id,
      contextChangeProposalId: bundle.contextChangeProposal.id,
      expectedContextVersionId,
      approvedByPrincipalId: principalId,
      approvedAt: this.clock(),
    });
  }

  async reject(
    principalId: string,
    projectId: string,
    proposalId: string,
    expectedContextVersionId: string,
  ): Promise<void> {
    await this.authorization.authorize(principalId, projectId, "review");
    const bundle = await this.requireBundle(projectId, proposalId);
    await this.assertCurrentVersion(
      projectId,
      bundle.decisionProposal.baseContextVersionId,
      expectedContextVersionId,
    );
    await this.reviewRepository.reject(
      projectId,
      bundle.decisionProposal.id,
      bundle.contextChangeProposal.id,
      this.clock(),
    );
  }

  private async requireBundle(
    projectId: string,
    proposalId: string,
  ): Promise<DecisionReviewBundle> {
    const bundle = await this.reviewRepository.getBundle(projectId, proposalId);
    if (!bundle) throw new DomainError("not_found", "Decision proposal not found.");
    return bundle;
  }

  private async assertCurrentVersion(
    projectId: string,
    proposalBaseVersionId: string,
    expectedContextVersionId: string,
  ): Promise<void> {
    if (expectedContextVersionId !== proposalBaseVersionId) {
      throw new DomainError(
        "stale_context_version",
        "Expected context version does not match the proposal base version.",
      );
    }

    const head = await this.contextVersions.getHead(projectId);
    if (!head || head.currentContextVersionId !== expectedContextVersionId) {
      throw new DomainError(
        "stale_context_version",
        "Project context has advanced since this proposal was generated.",
      );
    }
  }
}
