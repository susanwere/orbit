import { DomainError } from "@orbit/domain";

export interface StructuredJsonRequest {
  readonly timeoutMs?: number;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly schemaName: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface StructuredJsonClient {
  complete(request: StructuredJsonRequest): Promise<unknown>;
}

interface MetaModelApiClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class MetaModelApiClient implements StructuredJsonClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: MetaModelApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 20_000;

    if (!options.apiKey.trim()) {
      throw new DomainError("configuration_error", "MODEL_API_KEY is required.");
    }
  }

  async complete(request: StructuredJsonRequest): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        store: false,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: request.schema,
          },
        },
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
    });

    if (!response.ok) {
      throw new DomainError("model_api_error", `Meta Model API returned HTTP ${response.status}.`);
    }

    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.choices)) {
      throw new DomainError(
        "invalid_model_response",
        "Meta Model API response did not contain choices.",
      );
    }

    const firstChoice = body.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
      throw new DomainError(
        "invalid_model_response",
        "Meta Model API response did not contain a message.",
      );
    }

    const content = firstChoice.message.content;
    if (typeof content !== "string") {
      throw new DomainError(
        "invalid_model_response",
        "Meta Model API structured response content was not a string.",
      );
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new DomainError(
        "invalid_model_response",
        "Meta Model API structured response was not valid JSON.",
      );
    }
  }
}
