/**
 * ORB-21: frontend contracts aligned with the implemented Orbit backend V1.
 *
 * Domain entities are imported instead of redefined. Route-level read models
 * intentionally preserve the snake_case fields returned by SQL-backed GET APIs.
 * Do not treat planned onboarding, planning or provider integrations as live APIs.
 */
import type {
  AgentSession,
  ContextChangeOperation,
  ContextChangeProposal,
  ContextSnapshot,
  ContextVersion,
  Decision,
  DecisionProposal,
  Intent,
  Notification,
  ProjectContext,
  ProjectContextPreview,
} from "@orbit/domain";

export type {
  AgentSession,
  ContextChangeOperation,
  ContextChangeProposal,
  ContextSnapshot,
  ContextVersion,
  Decision,
  DecisionProposal,
  Intent,
  Notification,
  ProjectContext,
  ProjectContextPreview,
};

export interface DecisionReviewBundle {
  readonly decisionProposal: DecisionProposal;
  readonly contextChangeProposal: ContextChangeProposal;
}
export type DecisionReviewState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready" | "editing"; readonly review: DecisionReviewBundle }
  | {
      readonly status: "approving" | "rejecting" | "rebasing";
      readonly review: DecisionReviewBundle;
    }
  | { readonly status: "stale"; readonly review: DecisionReviewBundle; readonly message: string }
  | { readonly status: "applied" | "rejected" }
  | { readonly status: "failed"; readonly message: string };

export interface ContextHistoryItem {
  readonly id: string;
  readonly version_number: number;
  readonly created_at: string;
  readonly parent_context_version_id: string | null;
  readonly content_hash: string;
  readonly created_from_decision_id: string | null;
}
export interface ContextHistoryPage {
  readonly versions: readonly ContextHistoryItem[];
  readonly nextCursor: string | null;
}
export interface DecisionSummary {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly status: string;
  readonly created_at: string;
  readonly source_artifact_id: string;
  readonly kind: "decision" | "proposal";
}
export interface DecisionListPage {
  readonly decisions: readonly DecisionSummary[];
  readonly nextCursor: string | null;
}
export interface NotificationRow {
  readonly id: string;
  readonly type: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly title: string;
  readonly body: string;
  readonly read_at: string | null;
  readonly created_at: string;
}
export interface NotificationInbox {
  readonly notifications: readonly NotificationRow[];
  readonly unreadCount: number;
}
export interface HumanGateList {
  readonly gates: readonly Record<string, unknown>[];
}

/** SSE data contains occurredAt + payload; id and event type are SSE frame fields. */
export interface ProjectStreamEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type OrbitNodeKind =
  | "decision"
  | "guardrail"
  | "context"
  | "evidence"
  | "work_item"
  | "agent"
  | "human_gate"
  | "human"
  | "ci"
  | "release"
  | "pull_request"
  | "outcome";
export type OrbitNodeStatus = "empty" | "idle" | "active" | "attention" | "blocked" | "error";
export interface OrbitNodeModel {
  readonly id: OrbitNodeKind;
  readonly kind: OrbitNodeKind;
  readonly label: string;
  readonly status: OrbitNodeStatus;
  readonly summary: string;
  readonly attentionRequired: boolean;
  readonly activityCount: number;
  readonly updatedAt?: string;
}

/** Planned product models, not asserted backend REST responses. */
export interface ProjectDraft {
  readonly name: string;
  readonly repositoryUrl?: string;
  readonly originalIntent?: string;
}
export interface ProposedPlan {
  readonly id: string;
  readonly projectId: string;
  readonly workItems: readonly {
    readonly title: string;
    readonly acceptanceCriteria: readonly string[];
  }[];
  readonly status: "proposed" | "awaiting_approval" | "approved" | "rejected";
}
export type IntegrationCapabilityState =
  | {
      readonly status:
        | "not_implemented"
        | "disconnected"
        | "authorization_required"
        | "unavailable";
      readonly provider: string;
    }
  | {
      readonly status: "connected";
      readonly provider: string;
      readonly capabilities: readonly string[];
    };

/** UI-level contract for explicitly *planned* capabilities, not a REST response. */
export type FeatureAvailability =
  | {
      readonly status: "not_implemented";
      readonly feature:
        | "project_onboarding"
        | "intent_submission"
        | "planning"
        | "provider_oauth"
        | "provider_execution";
    }
  | { readonly status: "available" };

export type ApiFailure =
  | { readonly kind: "unauthenticated"; readonly status: 401; readonly message: string }
  | { readonly kind: "forbidden"; readonly status: 403; readonly message: string }
  | { readonly kind: "not_found"; readonly status: 404; readonly message: string }
  | { readonly kind: "stale_context_version"; readonly status: 409; readonly message: string }
  | {
      readonly kind: "validation" | "invalid_state" | "other";
      readonly status: number;
      readonly message: string;
    };

export type LoadState<T> =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "error"; readonly failure: ApiFailure };

/** Endpoint inventory is deliberately narrower than the speculative V1 design. */
export const backendV1Routes = {
  currentContext: "/projects/:projectId/context",
  contextHistory: "/projects/:projectId/context/versions",
  contextVersion: "/projects/:projectId/context/versions/:version",
  decisions: "/projects/:projectId/decisions",
  decision: "/projects/:projectId/decisions/:decisionId",
  decisionReview: "/projects/:projectId/decision-proposals/:proposalId",
  decisionReviewApprove: "/projects/:projectId/decision-proposals/:proposalId/approve",
  decisionReviewReject: "/projects/:projectId/decision-proposals/:proposalId/reject",
  decisionReviewRebase: "/projects/:projectId/decision-proposals/:proposalId/rebase",
  eventStream: "/projects/:projectId/events/stream",
  notifications: "/projects/:projectId/notifications",
  notificationRead: "/projects/:projectId/notifications/:notificationId/read",
  agentSession: "/projects/:projectId/agent-sessions/:sessionId",
  humanGates: "/projects/:projectId/human-gates",
  humanGateResolve: "/projects/:projectId/human-gates/:gateId/resolve",
} as const;
