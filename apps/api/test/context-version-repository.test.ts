import { describe, expect, it } from "vitest";
import {
  DomainError,
  type ProjectContext,
  type ProjectContextHead,
} from "@orbit/domain";
import { hashProjectContext } from "../src/modules/context/canonical-context.js";
import {
  ContextVersionRepository,
  buildNextContextVersion,
} from "../src/modules/context/context-version-repository.js";
import type {
  SqlDatabase,
  SqlExecutor,
  SqlQueryResult,
} from "../src/lib/sql.js";

const createdAt = new Date(0).toISOString();

function context(attributes: Record<string, string> = {}): ProjectContext {
  return {
    projectId: "project_1",
    originalIntentId: "intent_1",
    currentIntent: "Build a jobs viewer",
    constraints: [],
    attributes,
  };
}

describe("context hashing", () => {
  it("is stable across object key insertion order", () => {
    const left = context({ beta: "2", alpha: "1" });
    const right = context({ alpha: "1", beta: "2" });

    expect(hashProjectContext(left)).toBe(hashProjectContext(right));
    expect(hashProjectContext(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when semantic context changes", () => {
    expect(hashProjectContext(context({ mode: "load_more" }))).not.toBe(
      hashProjectContext(context({ mode: "infinite_scroll" })),
    );
  });
});

describe("context version construction", () => {
  it("creates version one when no current head exists", () => {
    const version = buildNextContextVersion(
      {
        id: "context_v1",
        organizationId: "org_1",
        projectId: "project_1",
        content: context(),
        expectedCurrentVersionId: null,
        createdAt,
      },
      null,
    );

    expect(version.versionNumber).toBe(1);
    expect(version.parentContextVersionId).toBeUndefined();
  });

  it("increments from the current immutable head", () => {
    const head: ProjectContextHead = {
      organizationId: "org_1",
      projectId: "project_1",
      currentContextVersionId: "context_v3",
      versionNumber: 3,
      updatedAt: createdAt,
    };

    const version = buildNextContextVersion(
      {
        id: "context_v4",
        organizationId: "org_1",
        projectId: "project_1",
        content: context({ pagination: "20" }),
        expectedCurrentVersionId: "context_v3",
        createdAt,
      },
      head,
    );

    expect(version.versionNumber).toBe(4);
    expect(version.parentContextVersionId).toBe("context_v3");
    expect(head.versionNumber).toBe(3);
    expect(head.currentContextVersionId).toBe("context_v3");
  });

  it("rejects stale expected context versions", () => {
    const head: ProjectContextHead = {
      organizationId: "org_1",
      projectId: "project_1",
      currentContextVersionId: "context_v4",
      versionNumber: 4,
      updatedAt: createdAt,
    };

    try {
      buildNextContextVersion(
        {
          id: "context_v5",
          organizationId: "org_1",
          projectId: "project_1",
          content: context(),
          expectedCurrentVersionId: "context_v3",
          createdAt,
        },
        head,
      );
      throw new Error("Expected stale context version to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("stale_context_version");
    }
  });
});

class HistoryDatabase implements SqlDatabase {
  constructor(private readonly rows: readonly Record<string, unknown>[]) {}

  async query<Row extends Record<string, unknown>>(
    _text: string,
    _params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return {
      rows: this.rows as unknown as readonly Row[],
      rowCount: this.rows.length,
    };
  }

  async transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }
}

describe("context version history", () => {
  it("returns versions in ascending version order", async () => {
    const base = {
      organization_id: "org_1",
      project_id: "project_1",
      parent_context_version_id: null,
      content: context(),
      content_hash: hashProjectContext(context()),
      created_from_decision_id: null,
      created_at: createdAt,
    };

    const repository = new ContextVersionRepository(
      new HistoryDatabase([
        { ...base, id: "context_v2", version_number: 2 },
        { ...base, id: "context_v1", version_number: 1 },
      ]),
    );

    const history = await repository.getHistory("project_1");

    expect(history.map((version) => version.versionNumber)).toEqual([1, 2]);
  });
});
