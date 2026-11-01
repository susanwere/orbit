import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { extractDocumentText, loadPlanningDocuments } from "./planning-documents.js";

describe("document text extraction", () => {
  it("normalizes UTF-8 Markdown", async () => {
    expect(await extractDocumentText("text/markdown", Buffer.from("# Overview\r\nA job portal"))).toBe("# Overview\nA job portal");
  });

  it("rejects unsupported file types", async () => {
    await expect(extractDocumentText("application/javascript", Buffer.from("code"))).rejects.toThrow("Unsupported");
  });

  it("only reads scoped intent attachments and enforces a total prompt limit", async () => {
    const bytes = Buffer.from("X".repeat(40_000));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const calls: unknown[][] = [];
    const db = { query: async (_query: string, params: unknown[]) => {
      calls.push(params);
      return { rows: [1, 2, 3, 4].map((n) => ({
        id: String(n), version: 1, original_filename: `source-${n}.md`,
        media_type: "text/markdown", storage_key: String(n), sha256,
      })) };
    } };
    const storage = { get: async () => bytes };
    const documents = await loadPlanningDocuments(db as never, storage as never, "org", "project", "intent");
    expect(calls[0]?.slice(0, 3)).toEqual(["org", "project", "intent"]);
    expect(documents.map((d) => d.excerpt.length)).toEqual([8000, 8000, 8000]);
    expect(documents[0]?.sha256).toBe(sha256);
  });

  it("refuses tampered document bytes", async () => {
    const db = { query: async () => ({ rows: [{ id:"1", version:1, original_filename:"a.md", media_type:"text/markdown", storage_key:"key", sha256:"0".repeat(64) }] }) };
    await expect(loadPlanningDocuments(db as never, { get: async () => Buffer.from("changed") } as never, "org", "project", "intent")).rejects.toThrow("integrity");
  });
});
