export interface PromoteDecisionInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly decisionProposalId: string;
  readonly contextChangeProposalId: string;
  readonly expectedContextVersionId: string;
  readonly approvedByPrincipalId: string;
  readonly approvedAt: string;
}

export interface PromoteDecisionResult {
  readonly decisionId: string;
  readonly contextVersionId: string;
  readonly versionNumber: number;
}

export interface DecisionPromotionPort {
  promote(input: PromoteDecisionInput): Promise<PromoteDecisionResult>;
}
