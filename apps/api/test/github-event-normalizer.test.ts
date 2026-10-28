import { describe, expect, it } from "vitest";
import { normalizeGitHubWebhook } from "../src/modules/integrations/github/event-normalizer.js";

const baseEnvelope = {
  organizationId: "org_1",
  projectId: "project_1",
  deliveryId: "delivery-1",
  receivedAt: "2026-10-28T10:00:00.000Z",
};

const repository = {
  full_name: "susanwere/orbit",
};

const sender = {
  id: 42,
  login: "susanwere",
  type: "User",
};

function pullRequest(number = 14) {
  return {
    number,
    title: "Implement jobs list",
    body: "PR body",
    html_url: `https://github.com/susanwere/orbit/pull/${number}`,
    created_at: "2026-10-28T09:00:00.000Z",
    updated_at: "2026-10-28T09:30:00.000Z",
    head: { sha: "head-sha" },
    base: { sha: "base-sha" },
  };
}

describe("GitHub event normalization", () => {
  it("normalizes pull request opened", () => {
    const event = normalizeGitHubWebhook({
      ...baseEnvelope,
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository,
        sender,
        pull_request: pullRequest(),
      },
    });

    expect(event).toMatchObject({
      organizationId: "org_1",
      projectId: "project_1",
      type: "pull_request.opened",
      correlationId: "github:pull_request:susanwere/orbit#14",
      causationId: "github:delivery:delivery-1",
      actor: {
        type: "human",
        id: "github-user:42",
        displayName: "susanwere",
      },
      entityType: "pull_request",
      entityId: "susanwere/orbit#14",
      sourceArtifact: {
        provider: "github",
        type: "pull_request",
        externalId: "susanwere/orbit#14",
      },
    });
    expect(event?.payload).toMatchObject({
      repositoryFullName: "susanwere/orbit",
      pullRequestNumber: 14,
      headSha: "head-sha",
      baseSha: "base-sha",
    });
  });

  it("normalizes synchronize as a provider-neutral synchronized event", () => {
    const event = normalizeGitHubWebhook({
      ...baseEnvelope,
      deliveryId: "delivery-sync",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        repository,
        sender,
        pull_request: pullRequest(),
      },
    });

    expect(event?.type).toBe("pull_request.synchronized");
  });

  it("normalizes a submitted review", () => {
    const event = normalizeGitHubWebhook({
      ...baseEnvelope,
      deliveryId: "delivery-review",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        repository,
        sender,
        pull_request: pullRequest(),
        review: {
          id: 77,
          state: "changes_requested",
          body: "Use explicit Load More.",
          commit_id: "head-sha",
          submitted_at: "2026-10-28T09:45:00.000Z",
          html_url: "https://github.com/susanwere/orbit/pull/14#pullrequestreview-77",
        },
      },
    });

    expect(event).toMatchObject({
      type: "pull_request.review_submitted",
      entityType: "pull_request_review",
      entityId: "susanwere/orbit#14:review:77",
    });
    expect(event?.payload).toMatchObject({
      reviewState: "changes_requested",
      body: "Use explicit Load More.",
      commitId: "head-sha",
    });
  });

  it("normalizes a created review comment", () => {
    const event = normalizeGitHubWebhook({
      ...baseEnvelope,
      deliveryId: "delivery-review-comment",
      eventName: "pull_request_review_comment",
      payload: {
        action: "created",
        repository,
        sender,
        pull_request: pullRequest(),
        comment: {
          id: 88,
          body: "Keep this explicit.",
          path: "src/jobs/JobsList.tsx",
          line: 31,
          start_line: 29,
          commit_id: "head-sha",
          created_at: "2026-10-28T09:50:00.000Z",
          html_url: "https://github.com/susanwere/orbit/pull/14#discussion_r88",
        },
      },
    });

    expect(event?.type).toBe("pull_request.review_comment_created");
    expect(event?.payload).toMatchObject({
      path: "src/jobs/JobsList.tsx",
      line: 31,
      startLine: 29,
      body: "Keep this explicit.",
    });
  });

  it("normalizes issue comments only when they belong to a pull request", () => {
    const pullRequestComment = normalizeGitHubWebhook({
      ...baseEnvelope,
      deliveryId: "delivery-pr-comment",
      eventName: "issue_comment",
      payload: {
        action: "created",
        repository,
        sender,
        issue: {
          number: 14,
          pull_request: {
            url: "https://api.github.com/repos/susanwere/orbit/pulls/14",
          },
        },
        comment: {
          id: 99,
          body: "Fetch 20 jobs at a time.",
          created_at: "2026-10-28T09:55:00.000Z",
          html_url: "https://github.com/susanwere/orbit/pull/14#issuecomment-99",
        },
      },
    });

    const regularIssueComment = normalizeGitHubWebhook({
      ...baseEnvelope,
      deliveryId: "delivery-issue-comment",
      eventName: "issue_comment",
      payload: {
        action: "created",
        repository,
        sender,
        issue: { number: 12 },
        comment: {
          id: 100,
          body: "Normal issue comment",
        },
      },
    });

    expect(pullRequestComment?.type).toBe("pull_request.comment_created");
    expect(pullRequestComment?.payload.body).toBe("Fetch 20 jobs at a time.");
    expect(regularIssueComment).toBeNull();
  });

  it("generates deterministic event IDs for safe reprocessing", () => {
    const envelope = {
      ...baseEnvelope,
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository,
        sender,
        pull_request: pullRequest(),
      },
    };

    expect(normalizeGitHubWebhook(envelope)?.id).toBe(
      normalizeGitHubWebhook(envelope)?.id,
    );
  });

  it("ignores unsupported GitHub events and actions", () => {
    expect(
      normalizeGitHubWebhook({
        ...baseEnvelope,
        eventName: "push",
        payload: { repository, sender },
      }),
    ).toBeNull();

    expect(
      normalizeGitHubWebhook({
        ...baseEnvelope,
        eventName: "pull_request",
        payload: {
          action: "closed",
          repository,
          sender,
          pull_request: pullRequest(),
        },
      }),
    ).toBeNull();
  });
});
