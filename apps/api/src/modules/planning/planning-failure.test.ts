import { DomainError } from "@orbit/domain";
import { describe, expect, it } from "vitest";
import { planningFailureMessage } from "./planning-failure.js";

describe("planningFailureMessage", () => {
  it.each([400, 401, 403, 404, 422, 429, 500, 503])(
    "reports a safe message for upstream HTTP %i",
    (status) => {
      const error = new DomainError(
        "model_api_error",
        `Meta Model API returned HTTP ${status}.`,
      );
      const message = planningFailureMessage(error);
      expect(message).toContain("Muse");
      expect(message).not.toContain("secret");
      expect(message).not.toBe("Muse is temporarily unavailable. Please retry.");
    },
  );

  it("keeps unrecognized provider errors generic", () => {
    const error = new DomainError("model_api_error", "secret from provider");
    expect(planningFailureMessage(error)).toBe(
      "Muse is temporarily unavailable. Please retry.",
    );
  });
});
