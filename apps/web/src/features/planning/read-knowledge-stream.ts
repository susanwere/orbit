import type { KnowledgeGenerationActivity } from "@orbit/domain";
import type { ProjectKnowledgeSnapshot } from "../intent/intent-api.js";

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
function isActivity(input: unknown): input is KnowledgeGenerationActivity {
  return (
    isRecord(input) &&
    ["sources", "documents", "repositories", "summary", "saving"].includes(String(input.stage)) &&
    ["started", "completed", "info"].includes(String(input.status)) &&
    typeof input.message === "string" &&
    input.message.length <= 1000 &&
    typeof input.occurredAt === "string" &&
    Number.isFinite(Date.parse(input.occurredAt))
  );
}

export async function readKnowledgeStream(
  response: Response,
  onActivity: (activity: KnowledgeGenerationActivity) => void,
): Promise<ProjectKnowledgeSnapshot> {
  if (!response.body)
    throw new Error(
      "Context activity stream is unavailable. Refresh to check for a saved proposal.",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  function readLine(line: string): ProjectKnowledgeSnapshot | undefined {
    if (!line.trim()) return;
    const event: unknown = JSON.parse(line);
    if (!isRecord(event)) throw new Error("Invalid context activity response.");
    if (event.type === "activity" && isActivity(event.activity)) {
      onActivity(event.activity);
      return;
    }
    if (event.type === "error" && typeof event.message === "string") throw new Error(event.message);
    if (
      event.type === "result" &&
      isRecord(event.snapshot) &&
      typeof event.snapshot.id === "string" &&
      typeof event.snapshot.revision === "number" &&
      isRecord(event.snapshot.content)
    )
      return event.snapshot as unknown as ProjectKnowledgeSnapshot;
    throw new Error("Invalid context activity response.");
  }
  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 1_000_000) throw new Error("Context activity response is too large.");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const snapshot = readLine(line);
        if (snapshot) return snapshot;
      }
      if (chunk.done) {
        const snapshot = readLine(pending);
        if (snapshot) return snapshot;
        break;
      }
    }
    throw new Error(
      "Connection closed before generation finished. Refresh to check for a saved proposal.",
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
