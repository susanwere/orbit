import { describe, expect, it } from "vitest";
import { decodeDocumentUpload } from "./project-document-routes.js";

describe("project document upload validation", () => {
  it("accepts a valid markdown document and computes its digest", () => {
    const result = decodeDocumentUpload({
      filename: "README.md",
      mediaType: "text/markdown",
      base64: Buffer.from("# Project").toString("base64"),
    });
    expect(result.filename).toBe("README.md");
    expect(result.contents.toString()).toBe("# Project");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    { filename: "../secret.md", mediaType: "text/markdown", base64: "eA==" },
    { filename: "note.exe", mediaType: "text/plain", base64: "eA==" },
    { filename: "readme.md", mediaType: "text/markdown", base64: "@@" },
    { filename: "empty.txt", mediaType: "text/plain", base64: "" },
    { filename: "invalid.pdf", mediaType: "application/pdf", base64: "eA==" },
  ])("rejects malformed or unsafe uploads %#", (input) => {
    expect(() => decodeDocumentUpload(input)).toThrow();
  });
});
