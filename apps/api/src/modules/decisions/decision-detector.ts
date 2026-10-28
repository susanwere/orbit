import type {
  Decision,
  OrbitEvent,
  ProjectContext,
} from "@orbit/domain";

export interface DecisionDetectionInput {
  readonly event: OrbitEvent;
  readonly currentContext: ProjectContext;
  readonly activeDecisions: readonly Decision[];
}

export interface DecisionCandidate {
  readonly confidence: number;
  readonly title: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly scope: readonly string[];
  readonly evidenceQuote: string;
}

export type DecisionDetectionResult =
  | {
      readonly kind: "candidate";
      readonly candidate: DecisionCandidate;
    }
  | {
      readonly kind: "none";
      readonly confidence: number;
      readonly reason:
        | "no_source_text"
        | "no_decision"
        | "low_confidence";
    };

export interface DecisionDetector {
  detect(input: DecisionDetectionInput): Promise<DecisionDetectionResult>;
}
