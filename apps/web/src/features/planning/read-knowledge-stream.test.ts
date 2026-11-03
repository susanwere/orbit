import { describe, expect, it, vi } from "vitest";
import { readKnowledgeStream } from "./read-knowledge-stream.js";

const activity = {
  stage: "summary",
  status: "started",
  message: "Waiting for Muse.",
  occurredAt: "2026-11-03T10:00:00Z",
};
const snapshot = { id: "snapshot", revision: 1, content: {} };
function streamResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7)
          controller.enqueue(bytes.slice(index, index + 7));
        controller.close();
      },
    }),
  );
}
describe("knowledge activity transport", () => {
  it("handles partial UTF-8 chunks and returns the proposal only after its result event", async () => {
    const onActivity = vi.fn();
    const response = streamResponse(
      JSON.stringify({ type: "activity", activity }) +
        "\n" +
        JSON.stringify({ type: "result", snapshot }) +
        "\n",
    );
    expect(await readKnowledgeStream(response, onActivity)).toEqual(snapshot);
    expect(onActivity).toHaveBeenCalledWith(activity);
  });
  it("rejects interrupted streams rather than claiming success", async () => {
    await expect(
      readKnowledgeStream(
        streamResponse(JSON.stringify({ type: "activity", activity }) + "\n"),
        vi.fn(),
      ),
    ).rejects.toThrow("Connection closed");
  });
  it("reports server failure and rejects malformed activity", async () => {
    await expect(
      readKnowledgeStream(
        streamResponse(JSON.stringify({ type: "error", message: "Generation failed." }) + "\n"),
        vi.fn(),
      ),
    ).rejects.toThrow("Generation failed.");
    await expect(
      readKnowledgeStream(
        streamResponse(
          JSON.stringify({ type: "activity", activity: { message: "invalid" } }) + "\n",
        ),
        vi.fn(),
      ),
    ).rejects.toThrow("Invalid context activity");
  });
});
