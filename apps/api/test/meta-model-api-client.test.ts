import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaModelApiClient } from "../src/modules/decisions/meta-model-client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
const request = {
  model: "muse-spark-1.3",
  systemPrompt: "Only output a JSON object.",
  userPrompt: "A PR discussion about pagination.",
  schemaName: "OrbitDecisionDetection",
  schema: { type: "object", properties: { isDecision: { type: "boolean" } },
    required: ["isDecision"], additionalProperties: false },
};

describe("direct Meta Model API client", () => {
  it("uses bearer auth, canonical API route, strict schema and no stored output", async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"isDecision":true}' } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = mock as typeof fetch;
    const client = new MetaModelApiClient({ apiKey: "test-only-key" });
    expect(await client.complete(request)).toEqual({ isDecision: true });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, options] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.meta.ai/v1/chat/completions");
    expect((options.headers as Record<string, string>).authorization).toBe("Bearer test-only-key");
    expect(JSON.parse(options.body as string)).toMatchObject({
      model: "muse-spark-1.3", store: false,
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
  });

  it("does not echo potentially sensitive Meta error responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      "sensitive prompt, token and provider trace", { status: 429 },
    )) as typeof fetch;
    const client = new MetaModelApiClient({ apiKey: "test-only-key" });
    await expect(client.complete(request)).rejects.toMatchObject({
      code: "model_api_error",
      message: "Meta Model API returned HTTP 429.",
    });
  });
});
