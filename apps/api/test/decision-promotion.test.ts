import { describe, expect, it } from "vitest";
import type {
  ProjectContextPreview,
} from "@orbit/domain";
import {
  materializeApprovedContext,
} from "../src/modules/decisions/postgres-decision-promotion.js";

const now = "2026-10-28T10:00:00.000Z";

describe("Decision promotion context materialization", () => {
  it("converts proposed constraint provenance to the authoritative Decision", () => {
    const preview: ProjectContextPreview = {
      projectId: "project_1",
      originalIntentId: "intent_1",
      currentIntent: "Build jobs",
      constraints: [
        {
          id: "existing",
          key: "api",
          statement: "Use HN API",
          sourceDecisionId: "decision_existing",
          createdAt: now,
        },
        {
          id: "proposed",
          key: "pagination",
          statement: "Use Load More",
          sourceDecisionProposalId: "dp_1",
          createdAt: now,
        },
      ],
      attributes: {},
    };

    const context = materializeApprovedContext(
      preview,
      "dp_1",
      "decision_1",
    );

    expect(context.constraints[0]).toMatchObject({
      sourceDecisionId: "decision_existing",
    });
    expect(context.constraints[1]).toEqual({
      id: "proposed",
      key: "pagination",
      statement: "Use Load More",
      sourceDecisionId: "decision_1",
      createdAt: now,
    });
    expect("sourceDecisionProposalId" in context.constraints[1]!).toBe(false);
  });

  it("rejects preview constraints belonging to a different proposal", () => {
    const preview: ProjectContextPreview = {
      projectId: "project_1",
      originalIntentId: "intent_1",
      currentIntent: "Build jobs",
      constraints: [
        {
          id: "foreign",
          key: "pagination",
          statement: "Use Load More",
          sourceDecisionProposalId: "dp_other",
          createdAt: now,
        },
      ],
      attributes: {},
    };

    expect(() =>
      materializeApprovedContext(preview, "dp_1", "decision_1"),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_context_preview" }),
    );
  });
});


import type { SqlDatabase, SqlExecutor, SqlQueryResult } from "@orbit/db";
import {
  PostgresDecisionPromotion,
  type PromotionIdKind,
} from "../src/modules/decisions/postgres-decision-promotion.js";
import type {
  CommittedDomainEvent,
  DomainEventPublisher,
} from "../src/modules/events/domain-event-publisher.js";

class RecordingPublisher implements DomainEventPublisher {
  events: readonly CommittedDomainEvent[] = [];
  shouldFail = false;

  async publish(events: readonly CommittedDomainEvent[]): Promise<void> {
    this.events = events;
    if (this.shouldFail) throw new Error("live stream unavailable");
  }
}

class PromotionDatabase implements SqlDatabase {
  readonly queries: string[] = [];
  committed = false;
  rolledBack = false;

  async query<Row extends Record<string, unknown>>(
    _text: string,
    _params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    throw new Error("Promotion queries must run inside a transaction.");
  }

  async transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const executor: SqlExecutor = {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        _params?: readonly unknown[],
      ): Promise<SqlQueryResult<Row>> => {
        this.queries.push(text);

        if (text.includes("FROM project_context_heads h")) {
          return result<Row>({
            organization_id: "org_1",
            project_id: "project_1",
            current_context_version_id: "context_v3",
            version_number: 3,
            current_content: {
              projectId: "project_1",
              originalIntentId: "intent_1",
              currentIntent: "Build jobs",
              constraints: [],
              attributes: {},
            },
          });
        }
        if (text.includes("FROM decision_proposals")) {
          return result<Row>({
            id: "dp_1",
            organization_id: "org_1",
            project_id: "project_1",
            source_artifact_id: "artifact_1",
            title: "Use Load More",
            rationale: "Keep loading explicit",
            alternatives: [],
            scope: ["jobs"],
            base_context_version_id: "context_v3",
            status: "READY_FOR_REVIEW",
          });
        }
        if (text.includes("FROM context_change_proposals") && text.includes("FOR UPDATE")) {
          return result<Row>({
            id: "ccp_1",
            organization_id: "org_1",
            project_id: "project_1",
            decision_proposal_id: "dp_1",
            base_context_version_id: "context_v3",
            revision: 1,
            operations: [
              {
                op: "add",
                path: "/constraints/-",
                value: {
                  id: "constraint_proposed_dp_1",
                  key: "decision.dp_1",
                  statement: "Use Load More",
                  sourceDecisionProposalId: "dp_1",
                  createdAt: now,
                },
              },
            ],
            resulting_context_preview: {
              projectId: "project_1",
              originalIntentId: "intent_1",
              currentIntent: "Build jobs",
              constraints: [
                {
                  id: "constraint_proposed_dp_1",
                  key: "decision.dp_1",
                  statement: "Use Load More",
                  sourceDecisionProposalId: "dp_1",
                  createdAt: now,
                },
              ],
              attributes: {},
            },
            status: "READY_FOR_REVIEW",
          });
        }
        if (text.includes("MAX(revision)")) {
          return result<Row>({ max_revision: 1 });
        }

        return { rows: [], rowCount: 1 };
      },
    };

    try {
      const value = await work(executor);
      this.committed = true;
      return value;
    } catch (error) {
      this.rolledBack = true;
      throw error;
    }
  }
}

function result<Row extends Record<string, unknown>>(
  row: Record<string, unknown>,
): SqlQueryResult<Row> {
  return {
    rows: [row as unknown as Row],
    rowCount: 1,
  };
}

function ids(kind: PromotionIdKind): string {
  const values = {
    approval: "approval_1",
    decision: "decision_1",
    context: "context_v4",
    event: "event_1",
  };
  return values[kind];
}

describe("PostgresDecisionPromotion transaction boundary", () => {
  it("commits the whole promotion before publishing events", async () => {
    const database = new PromotionDatabase();
    const publisher = new RecordingPublisher();
    const promoter = new PostgresDecisionPromotion(database, publisher, ids);

    const output = await promoter.promote({
      organizationId: "org_1",
      projectId: "project_1",
      decisionProposalId: "dp_1",
      contextChangeProposalId: "ccp_1",
      expectedContextVersionId: "context_v3",
      approvedByPrincipalId: "usr_1",
      approvedAt: now,
    });

    expect(output).toEqual({
      decisionId: "decision_1",
      contextVersionId: "context_v4",
      versionNumber: 4,
    });
    expect(database.committed).toBe(true);
    expect(publisher.events.map((event) => event.type)).toEqual([
      "decision.accepted",
      "context.version_created",
      "context.updated",
    ]);
  });

  it("does not publish anything when the transaction rolls back", async () => {
    const database = new PromotionDatabase();
    const originalTransaction = database.transaction.bind(database);
    database.transaction = async () => {
      database.rolledBack = true;
      throw new Error("database failure");
    };
    const publisher = new RecordingPublisher();
    const promoter = new PostgresDecisionPromotion(database, publisher, ids);

    await expect(
      promoter.promote({
        organizationId: "org_1",
        projectId: "project_1",
        decisionProposalId: "dp_1",
        contextChangeProposalId: "ccp_1",
        expectedContextVersionId: "context_v3",
        approvedByPrincipalId: "usr_1",
        approvedAt: now,
      }),
    ).rejects.toThrow("database failure");

    expect(database.rolledBack).toBe(true);
    expect(publisher.events).toEqual([]);
    void originalTransaction;
  });

  it("returns the committed result even if live publication fails", async () => {
    const database = new PromotionDatabase();
    const publisher = new RecordingPublisher();
    publisher.shouldFail = true;
    const publishErrors: unknown[] = [];
    const promoter = new PostgresDecisionPromotion(
      database,
      publisher,
      ids,
      (error) => publishErrors.push(error),
    );

    const output = await promoter.promote({
      organizationId: "org_1",
      projectId: "project_1",
      decisionProposalId: "dp_1",
      contextChangeProposalId: "ccp_1",
      expectedContextVersionId: "context_v3",
      approvedByPrincipalId: "usr_1",
      approvedAt: now,
    });

    expect(database.committed).toBe(true);
    expect(output.contextVersionId).toBe("context_v4");
    expect(publishErrors).toHaveLength(1);
  });
});
