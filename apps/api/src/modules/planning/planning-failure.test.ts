import { describe, expect, it } from "vitest";
import { DomainError } from "@orbit/domain";
import { planningFailureMessage } from "./planning-failure.js";

describe("planningFailureMessage", () => {
  it.each([
    [400, "Muse rejected the planning request (HTTP 400). Check model parameters and the structured output schema."],
    [401, "Muse rejected the API credentials. Check the model API configuration."],
    [403, "Muse rejected the API credentials. Check the model API configuration."],
    [404, "Muse returned HTTP 404. Check the model API base URL and model availability."],
    [422, "Muse rejected the planning request (HTTP 422). Check model parameters and the structured output schema."],
    [429, "Muse is rate limited. Please wait a moment and retry."],
    [500, "Muse model API returned HTTP 500. Check provider status and configuration."],
    [503, "Muse service returned HTTP 503. Retry after checking provider status."],
  ])("explains upstream HTTP %i without exposing provider payloads", (status, expected) => {
    expect(
      planningFailureMessage(
        new DomainError("model_api_error", `Meta Model API returned HTTP ${status}.`),
      ),
    ).toBe(expected);
  });

  it("keeps unknown provider errors generic", () => {
    expect(
      planningFailureMessage(new DomainError("model_api_error", "secret from provider")),
    ).toBe("Muse is temporarily unavailable. Please retry.");
  });
});
