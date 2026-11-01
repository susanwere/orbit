import { createHash } from "node:crypto";

export function extractMuseReviewOutput(events: readonly unknown[]): string | null {
  let finalText = "";
  let commandId: unknown;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.schema_version !== 1 || !record.payload || typeof record.payload !== "object")
      continue;
    const payload = record.payload as Record<string, unknown>;
    if (
      record.payload_type === "runtime.command.accepted" &&
      payload.command_kind === "turn.submit"
    )
      commandId ??= payload.command_id;
    if (
      commandId &&
      record.payload_type === "run.terminal.completed" &&
      payload.command_id === commandId &&
      payload.terminal === "completed" &&
      typeof payload.text === "string"
    )
      finalText = payload.text;
  }
  if (!finalText.trim() || finalText.length > 20000) return null;
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_]{12,}|(?:authorization|api[_-]?key)\s*[:=]\s*\S+/i.test(
      finalText,
    )
  )
    return null;
  if (
    [
      process.env.META_API_KEY,
      process.env.MODEL_API_KEY,
      process.env.ORBIT_WORKER_GITHUB_TOKEN,
    ].some((credential) => credential && credential.length >= 8 && finalText.includes(credential))
  )
    return null;
  return finalText.trim();
}

export function hashMuseReviewOutput(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
