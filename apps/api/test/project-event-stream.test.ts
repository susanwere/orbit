import { describe, expect, it } from "vitest";
import { ProjectEventStream } from "../src/modules/events/project-event-stream.js";

const events = [
  {
    id: "a",
    type: "decision.accepted",
    occurred_at: "2026-10-28T10:00:00Z",
    payload: { decisionId: "d1" },
  },
  {
    id: "b",
    type: "context.updated",
    occurred_at: "2026-10-28T10:00:01Z",
    payload: { version: 4 },
  },
];

class MemoryDatabase {
  async query(_sql: string, params: readonly unknown[]) {
    const [projectId, after] = params;
    if (projectId !== "project1") return { rows: [] };
    if (_sql.includes("id = $2")) {
      return { rows: events.filter((event) => event.id === after) };
    }
    const id = params[2];
    return {
      rows: events
        .filter(
          (event) =>
            !after ||
            event.occurred_at > after ||
            (event.occurred_at === after && event.id > String(id)),
        )
        .slice(0, Number(params[3])),
    };
  }
}

describe("ProjectEventStream", () => {
  const stream = new ProjectEventStream(new MemoryDatabase() as never);

  it("returns committed events ordered and with a stable cursor", async () => {
    const first = await stream.read("project1", null, 1);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ id: "a", type: "decision.accepted" });
    const second = await stream.read("project1", first.cursor);
    expect(second.events.map((e) => e.id)).toEqual(["b"]);
  });

  it("resolves an exact event-id cursor for reconnection", async () => {
    expect(await stream.cursor("project1", "a")).toEqual({
      at: "2026-10-28T10:00:00Z",
      id: "a",
    });
  });

  it("rejects unknown or cross-project replay identifiers", async () => {
    await expect(stream.cursor("project1", "missing")).rejects.toMatchObject({
      code: "validation",
    });
    await expect(stream.cursor("another", "a")).rejects.toMatchObject({
      code: "validation",
    });
  });
});
