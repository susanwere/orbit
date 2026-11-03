import { describe, expect, it } from "vitest";
import { DomainError } from "@orbit/domain";
import { planningFailureMessage } from "../src/modules/planning/planning-failure.js";

describe("safe planning failures", () => {
  it("distinguishes timeouts, rate limits, invalid plans and configuration failures", () => {
    expect(planningFailureMessage(new DOMException("private request", "TimeoutError"))).toContain(
      "timed out",
    );
    expect(
      planningFailureMessage(
        new DomainError("model_api_error", "Meta Model API returned HTTP 429."),
      ),
    ).toContain("rate limited");
    expect(
      planningFailureMessage(
        new DomainError("model_api_error", "Meta Model API returned HTTP 401."),
      ),
    ).toContain("credentials");
    expect(
      planningFailureMessage(new DomainError("invalid_model_output", "private output")),
    ).toContain("invalid plan");
  });
  it("never exposes arbitrary error messages or provider response bodies", () => {
    for (const error of [
      new Error("private prompt and key"),
      new DomainError("model_api_error", "private provider body"),
      new DomainError("database_error", "private query"),
    ]) {
      expect(planningFailureMessage(error)).not.toContain("private");
    }
  });
});
