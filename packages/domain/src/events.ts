import type { SourceArtifactType } from "./decisions.js";
import type { Id, JsonValue, PrincipalType } from "./types.js";

export type OrbitEventType =
  | "pull_request.opened"
  | "pull_request.synchronized"
  | "pull_request.review_submitted"
  | "pull_request.review_comment_created"
  | "pull_request.comment_created";

export interface OrbitEventActor {
  readonly type: PrincipalType;
  readonly id: string;
  readonly displayName?: string;
}

export interface OrbitEventSourceArtifact {
  readonly provider: string;
  readonly type: SourceArtifactType;
  readonly externalId: string;
  readonly url?: string;
}

export interface OrbitEvent {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly type: OrbitEventType;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly actor: OrbitEventActor;
  readonly entityType:
    | "pull_request"
    | "pull_request_review"
    | "pull_request_comment";
  readonly entityId: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly sourceArtifact: OrbitEventSourceArtifact;
}
