import type { KnowledgeArchitecture } from "@orbit/domain";

const text = { type: "string" } as const;
const strings = { type: "array", items: text } as const;
export const KNOWLEDGE_ARCHITECTURE_SCHEMA = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { label: text, description: text },
            required: ["label", "description"],
          },
        },
        dataFlow: strings,
      },
      required: ["facts", "dataFlow"],
    },
  ],
} as const;
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid architecture evidence.");
  return input as Record<string, unknown>;
}
function boundedText(input: unknown, limit: number): string {
  if (typeof input !== "string" || !input.trim() || input.length > limit)
    throw new Error("Invalid architecture text.");
  return input.trim();
}
function list(input: unknown, limit: number): unknown[] {
  if (!Array.isArray(input) || input.length > limit) throw new Error("Invalid architecture list.");
  return input;
}
export function parseKnowledgeArchitecture(input: unknown): KnowledgeArchitecture | null {
  if (input === undefined || input === null) return null;
  const architecture = record(input);
  const facts = list(architecture.facts, 8).map((entry) => {
    const fact = record(entry);
    return { label: boundedText(fact.label, 80), description: boundedText(fact.description, 500) };
  });
  const dataFlow = list(architecture.dataFlow, 10).map((step) => boundedText(step, 600));
  return { facts, dataFlow };
}
