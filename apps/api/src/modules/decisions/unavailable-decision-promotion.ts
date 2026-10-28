import { DomainError } from "@orbit/domain";
import type {
  DecisionPromotionPort,
  PromoteDecisionInput,
  PromoteDecisionResult,
} from "./decision-promotion-port.js";

export class UnavailableDecisionPromotion implements DecisionPromotionPort {
  async promote(_input: PromoteDecisionInput): Promise<PromoteDecisionResult> {
    throw new DomainError(
      "promotion_unavailable",
      "Atomic Decision promotion is not configured.",
    );
  }
}
