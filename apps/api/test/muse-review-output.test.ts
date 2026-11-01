import { describe, expect, it } from "vitest";
import { extractMuseReviewOutput } from "../src/modules/execution/muse-review-output.js";
const accepted = {
  schema_version: 1,
  payload_type: "runtime.command.accepted",
  payload: { command_kind: "turn.submit", command_id: "main" },
};
const finished = (text: string, commandId = "main") => ({
  schema_version: 1,
  payload_type: "run.terminal.completed",
  payload: { command_id: commandId, terminal: "completed", text },
});
describe("bounded Muse final response retention", () => {
  it("uses the installed JSONL terminal envelope and excludes tool output and child responses", () => {
    expect(
      extractMuseReviewOutput([
        accepted,
        { type: "tool_result", text: "SECRET tool output" },
        finished("Child response", "child"),
        finished("Draft: Hello World / Hallo Welt / Habari Dunia"),
      ]),
    ).toBe("Draft: Hello World / Hallo Welt / Habari Dunia");
  });
  it("refuses missing, oversized, unrecognized and credential-bearing output", () => {
    for (const events of [
      [],
      [accepted],
      [accepted, finished(" ")],
      [accepted, finished("a".repeat(20001))],
      [accepted, finished("token ghp_abcdefghijklmnop")],
      [accepted, finished("Authorization: Bearer-secret")],
      [accepted, { type: "final", text: "not recognized" }],
    ])
      expect(extractMuseReviewOutput(events)).toBeNull();
  });
});
