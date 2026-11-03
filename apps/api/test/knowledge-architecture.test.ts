import { describe, expect, it } from "vitest";
import { parseKnowledgeArchitecture } from "../src/modules/context/knowledge-architecture.js";
const architecture = {
  facts: [{ label: "Persistence", description: "Observed PostgreSQL configuration." }],
  dataFlow: ["Browser calls the API."],
};
describe("structured architecture facts", () => {
  it("preserves facts and supports legacy versions", () => {
    expect(parseKnowledgeArchitecture(architecture)).toEqual(architecture);
    expect(parseKnowledgeArchitecture(undefined)).toBeNull();
  });
  it("rejects excessive lists and malformed facts", () => {
    expect(() =>
      parseKnowledgeArchitecture({ ...architecture, dataFlow: Array(11).fill("step") }),
    ).toThrow("Invalid architecture list");
    expect(() =>
      parseKnowledgeArchitecture({ ...architecture, facts: [{ label: "Auth", description: 12 }] }),
    ).toThrow("Invalid architecture text");
  });
});
