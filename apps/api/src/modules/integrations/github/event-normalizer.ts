import { createHash } from "node:crypto";
import type {
  JsonValue,
  OrbitEvent,
  OrbitEventActor,
  OrbitEventSourceArtifact,
  OrbitEventType,
} from "@orbit/domain";

export interface GitHubWebhookEnvelope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly receivedAt: string;
}

type JsonRecord = Record<string, unknown>;

const MAX_BODY_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 1_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringAt(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberAt(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function repositoryName(payload: JsonRecord): string | undefined {
  return stringAt(recordAt(payload, "repository") ?? {}, "full_name");
}

function pullRequestNumber(payload: JsonRecord): number | undefined {
  const pullRequest = recordAt(payload, "pull_request");
  if (pullRequest) return numberAt(pullRequest, "number");

  const issue = recordAt(payload, "issue");
  return issue ? numberAt(issue, "number") : undefined;
}

function actorFrom(payload: JsonRecord): OrbitEventActor {
  const sender = recordAt(payload, "sender");
  const login = sender ? stringAt(sender, "login") : undefined;
  const id = sender ? numberAt(sender, "id") : undefined;
  const senderType = sender ? stringAt(sender, "type") : undefined;

  return {
    type: senderType === "Bot" ? "integration" : "human",
    id: id !== undefined ? `github-user:${id}` : login ? `github-user:${login}` : "github-user:unknown",
    displayName: login,
  };
}

function deterministicEventId(
  deliveryId: string,
  type: OrbitEventType,
  entityId: string,
): string {
  const digest = createHash("sha256")
    .update(`${deliveryId}:${type}:${entityId}`, "utf8")
    .digest("hex")
    .slice(0, 24);

  return `evt_${digest}`;
}

function occurredAt(
  preferred: string | undefined,
  fallback: string,
): string {
  return preferred ?? fallback;
}

function buildEvent(input: {
  envelope: GitHubWebhookEnvelope;
  type: OrbitEventType;
  repositoryFullName: string;
  pullRequestNumber: number;
  entityType: OrbitEvent["entityType"];
  entityId: string;
  occurredAt?: string;
  payload: Record<string, JsonValue>;
  sourceArtifact: OrbitEventSourceArtifact;
}): OrbitEvent {
  const correlationId =
    `github:pull_request:${input.repositoryFullName}#${input.pullRequestNumber}`;

  return {
    id: deterministicEventId(
      input.envelope.deliveryId,
      input.type,
      input.entityId,
    ),
    organizationId: input.envelope.organizationId,
    projectId: input.envelope.projectId,
    type: input.type,
    occurredAt: occurredAt(input.occurredAt, input.envelope.receivedAt),
    correlationId,
    causationId: `github:delivery:${input.envelope.deliveryId}`,
    actor: actorFrom(input.envelope.payload as JsonRecord),
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    sourceArtifact: input.sourceArtifact,
  };
}

function normalizePullRequest(
  envelope: GitHubWebhookEnvelope,
  payload: JsonRecord,
): OrbitEvent | null {
  const action = stringAt(payload, "action");
  const type: OrbitEventType | undefined =
    action === "opened"
      ? "pull_request.opened"
      : action === "synchronize"
        ? "pull_request.synchronized"
        : undefined;
  if (!type) return null;

  const pr = recordAt(payload, "pull_request");
  const repo = repositoryName(payload);
  const number = pr ? numberAt(pr, "number") : undefined;
  if (!pr || !repo || number === undefined) return null;

  const eventPayload: Record<string, JsonValue> = {
    action,
    repositoryFullName: repo,
    pullRequestNumber: number,
  };

  const title = boundedText(stringAt(pr, "title"), MAX_TITLE_LENGTH);
  const body = boundedText(stringAt(pr, "body"), MAX_BODY_LENGTH);
  const head = recordAt(pr, "head");
  const base = recordAt(pr, "base");
  const headSha = head ? stringAt(head, "sha") : undefined;
  const baseSha = base ? stringAt(base, "sha") : undefined;

  if (title !== undefined) eventPayload.title = title;
  if (body !== undefined) eventPayload.body = body;
  if (headSha !== undefined) eventPayload.headSha = headSha;
  if (baseSha !== undefined) eventPayload.baseSha = baseSha;

  return buildEvent({
    envelope,
    type,
    repositoryFullName: repo,
    pullRequestNumber: number,
    entityType: "pull_request",
    entityId: `${repo}#${number}`,
    occurredAt: stringAt(pr, "updated_at") ?? stringAt(pr, "created_at"),
    payload: eventPayload,
    sourceArtifact: {
      provider: "github",
      type: "pull_request",
      externalId: `${repo}#${number}`,
      url: stringAt(pr, "html_url"),
    },
  });
}

function normalizeReview(
  envelope: GitHubWebhookEnvelope,
  payload: JsonRecord,
): OrbitEvent | null {
  if (stringAt(payload, "action") !== "submitted") return null;

  const review = recordAt(payload, "review");
  const pr = recordAt(payload, "pull_request");
  const repo = repositoryName(payload);
  const number = pr ? numberAt(pr, "number") : undefined;
  const reviewId = review ? numberAt(review, "id") : undefined;
  if (!review || !pr || !repo || number === undefined || reviewId === undefined) {
    return null;
  }

  const body = boundedText(stringAt(review, "body"), MAX_BODY_LENGTH);
  const state = stringAt(review, "state");
  const commitId = stringAt(review, "commit_id");
  const eventPayload: Record<string, JsonValue> = {
    repositoryFullName: repo,
    pullRequestNumber: number,
    reviewId,
  };
  if (body !== undefined) eventPayload.body = body;
  if (state !== undefined) eventPayload.reviewState = state;
  if (commitId !== undefined) eventPayload.commitId = commitId;

  return buildEvent({
    envelope,
    type: "pull_request.review_submitted",
    repositoryFullName: repo,
    pullRequestNumber: number,
    entityType: "pull_request_review",
    entityId: `${repo}#${number}:review:${reviewId}`,
    occurredAt: stringAt(review, "submitted_at"),
    payload: eventPayload,
    sourceArtifact: {
      provider: "github",
      type: "pull_request_review",
      externalId: `${repo}#${number}:review:${reviewId}`,
      url: stringAt(review, "html_url"),
    },
  });
}

function normalizeReviewComment(
  envelope: GitHubWebhookEnvelope,
  payload: JsonRecord,
): OrbitEvent | null {
  if (stringAt(payload, "action") !== "created") return null;

  const comment = recordAt(payload, "comment");
  const pr = recordAt(payload, "pull_request");
  const repo = repositoryName(payload);
  const number = pr ? numberAt(pr, "number") : undefined;
  const commentId = comment ? numberAt(comment, "id") : undefined;
  if (!comment || !pr || !repo || number === undefined || commentId === undefined) {
    return null;
  }

  const eventPayload: Record<string, JsonValue> = {
    repositoryFullName: repo,
    pullRequestNumber: number,
    commentId,
  };

  const body = boundedText(stringAt(comment, "body"), MAX_BODY_LENGTH);
  const path = stringAt(comment, "path");
  const commitId = stringAt(comment, "commit_id");
  const line = numberAt(comment, "line");
  const startLine = numberAt(comment, "start_line");

  if (body !== undefined) eventPayload.body = body;
  if (path !== undefined) eventPayload.path = path;
  if (commitId !== undefined) eventPayload.commitId = commitId;
  if (line !== undefined) eventPayload.line = line;
  if (startLine !== undefined) eventPayload.startLine = startLine;

  return buildEvent({
    envelope,
    type: "pull_request.review_comment_created",
    repositoryFullName: repo,
    pullRequestNumber: number,
    entityType: "pull_request_comment",
    entityId: `${repo}#${number}:review-comment:${commentId}`,
    occurredAt: stringAt(comment, "created_at"),
    payload: eventPayload,
    sourceArtifact: {
      provider: "github",
      type: "pull_request_comment",
      externalId: `${repo}#${number}:review-comment:${commentId}`,
      url: stringAt(comment, "html_url"),
    },
  });
}

function normalizeIssueComment(
  envelope: GitHubWebhookEnvelope,
  payload: JsonRecord,
): OrbitEvent | null {
  if (stringAt(payload, "action") !== "created") return null;

  const issue = recordAt(payload, "issue");
  const comment = recordAt(payload, "comment");
  // GitHub's issue_comment event covers both issues and pull requests. Orbit
  // only normalizes it here when the issue payload identifies a pull request.
  if (!issue || !comment || !recordAt(issue, "pull_request")) return null;

  const repo = repositoryName(payload);
  const number = numberAt(issue, "number");
  const commentId = numberAt(comment, "id");
  if (!repo || number === undefined || commentId === undefined) return null;

  const eventPayload: Record<string, JsonValue> = {
    repositoryFullName: repo,
    pullRequestNumber: number,
    commentId,
  };
  const body = boundedText(stringAt(comment, "body"), MAX_BODY_LENGTH);
  if (body !== undefined) eventPayload.body = body;

  return buildEvent({
    envelope,
    type: "pull_request.comment_created",
    repositoryFullName: repo,
    pullRequestNumber: number,
    entityType: "pull_request_comment",
    entityId: `${repo}#${number}:comment:${commentId}`,
    occurredAt: stringAt(comment, "created_at"),
    payload: eventPayload,
    sourceArtifact: {
      provider: "github",
      type: "issue_comment",
      externalId: `${repo}#${number}:comment:${commentId}`,
      url: stringAt(comment, "html_url"),
    },
  });
}

/**
 * Converts GitHub's provider-specific webhook shape into one bounded Orbit
 * event. Unsupported/irrelevant webhook actions return null.
 *
 * Text remains untrusted input. Normalization does not infer intent, decisions,
 * or authority; it only extracts the minimum fields needed downstream.
 */
export function normalizeGitHubWebhook(
  envelope: GitHubWebhookEnvelope,
): OrbitEvent | null {
  if (!isRecord(envelope.payload)) return null;

  switch (envelope.eventName) {
    case "pull_request":
      return normalizePullRequest(envelope, envelope.payload);
    case "pull_request_review":
      return normalizeReview(envelope, envelope.payload);
    case "pull_request_review_comment":
      return normalizeReviewComment(envelope, envelope.payload);
    case "issue_comment":
      return normalizeIssueComment(envelope, envelope.payload);
    default:
      return null;
  }
}
