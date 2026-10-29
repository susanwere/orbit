import type { ContextChangeProposal, ContextVersion } from "@orbit/domain";
import type { DecisionCandidate } from "../decisions/decision-detector.js";
import {
  generateContextChangeProposal,
  type GenerateContextChangeProposalInput,
} from "./context-change-generator.js";
import { ContextChangeProposalRepository } from "./context-change-proposal-repository.js";

export interface ProposeContextChangeInput {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly decisionProposalId: string;
  readonly baseContextVersion: ContextVersion;
  readonly candidate: DecisionCandidate;
  readonly createdAt: string;
  readonly allowedPaths?: readonly string[];
}

/**
 * Application service boundary. Generation is pure and deterministic; storage
 * persists exactly the operations + preview that the human will later review.
 */
export class ContextChangeProposalService {
  constructor(private readonly repository: ContextChangeProposalRepository) {}

  async propose(input: ProposeContextChangeInput): Promise<ContextChangeProposal> {
    const proposalInput: GenerateContextChangeProposalInput = {
      ...input,
      revision: 1,
    };
    const proposal = generateContextChangeProposal(proposalInput);
    return this.repository.create(proposal);
  }
}
