import { describe, expect, it } from "vitest";
import {
  summarizeMuseEvent,
  createExecutionActivityRecorder,
} from "../src/modules/execution/muse-execution-activity.js";
import { MuseJsonLineDecoder } from "../src/modules/execution/muse-code-executor.js";

const event = (payloadType: string, payload: Record<string, unknown> = {}) => ({
  schema_version: 1,
  payload_type: payloadType,
  payload,
});
describe("safe execution activity", () => {
  it("summarizes tool events without retaining commands, prompts, output or credentials", () => {
    const activity = summarizeMuseEvent(
      event("tool.execution.started", {
        tool_name: "exec_command",
        arguments: "cat .env",
        output: "token ghp_abcdefghijklmnop",
        prompt: "private intent",
      }),
    );
    expect(activity?.message).toBe("Muse is running an authorized command.");
    expect(JSON.stringify(activity)).not.toMatch(/ghp_|\.env|private intent/);
    expect(
      summarizeMuseEvent(event("tool.execution.started", { tool_name: "Authorization: secret" }))
        ?.message,
    ).toBe("Muse is using an execution tool.");
  });
  it("ignores diagnostics, malformed envelopes and unsupported events", () => {
    for (const unsupported of [
      null,
      "text",
      [],
      { schema_version: 2, payload_type: "tool.execution.started", payload: {} },
      event("unknown.secret", { text: "secret" }),
    ])
      expect(summarizeMuseEvent(unsupported)).toBeNull();
  });
  it("does not interpret provider turn completion as workflow completion", () => {
    expect(
      summarizeMuseEvent(
        event("run.terminal.completed", { terminal: "completed", text: "All tests passed!" }),
      ),
    ).toEqual({
      stage: "output",
      status: "info",
      message: "Muse reported a completed turn. Verification is still required.",
    });
  });
  it("frames split JSONL, ignores diagnostics and flushes an unterminated final line", () => {
    const decoder = new MuseJsonLineDecoder();
    expect(decoder.push('{"schema_ver')).toEqual([]);
    expect(decoder.push('sion":1}\nnon-json diagnostic\n{"text":"')).toEqual([
      { schema_version: 1 },
    ]);
    expect(decoder.push('purple 💜"}')).toEqual([]);
    expect(decoder.finish()).toEqual([{ text: "purple 💜" }]);
    expect(decoder.finish()).toEqual([]);
  });
  it("deduplicates repeated messages, bounds writes, and scopes inserts to a live worker attempt", async () => {
    const writes: { sql: string; parameters?: readonly unknown[] }[] = [];
    const recorder = createExecutionActivityRecorder(
      {
        query: async (sql, parameters) => {
          writes.push({ sql, parameters });
          return { rows: [], rowCount: 0 };
        },
      },
      { jobId: "job", projectId: "project", organizationId: "org", attempt: 2 },
    );
    const entry = { stage: "tools" as const, status: "info" as const, message: "Tool activity." };
    await recorder(entry);
    await recorder(entry);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.parameters).toEqual([
      "job",
      "project",
      "org",
      "tools",
      "info",
      "Tool activity.",
      2,
    ]);
    expect(writes[0]?.sql).toContain("organization_id=$3 AND attempts=$7");
    expect(writes[0]?.sql).toContain("lease_expires_at > now()");
    for (let index = 0; index < 1005; index++)
      await recorder({ ...entry, message: `Tool activity ${index}` });
    expect(writes).toHaveLength(1000);
  });
});
