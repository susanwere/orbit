import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentAuthorizationModal, authorizeExecutionAgent } from "./AgentAuthorizationModal.js";

describe("agent authorization modal", () => {
  it("does not authorize or execute merely by rendering the modal", () => {
    const api = { getRepositories: vi.fn(), connectRepository: vi.fn(), onboardMuse: vi.fn() };
    const onAuthorized = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(AgentAuthorizationModal, {
        api,
        projectId: "project",
        workItemTitle: "Implement pagination",
        onClose: vi.fn(),
        onAuthorized,
      }),
    );
    expect(markup).toContain("<dialog");
    expect(markup).toContain("Authorize Muse Code");
    expect(markup).toContain("Implement pagination");
    expect(markup).toContain("Authorize &amp; execute");
    expect(markup).toMatch(/disabled=""[^>]*>Authorize &amp; execute/);
    expect(api.onboardMuse).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("requires explicit acknowledgment and an exact repository before requesting authorization", async () => {
    const api = { onboardMuse: vi.fn().mockResolvedValue(undefined) };
    await expect(
      authorizeExecutionAgent(api, "project", "owner/repository", false),
    ).rejects.toThrow("authorize Muse Code");
    await expect(authorizeExecutionAgent(api, "project", "  ", true)).rejects.toThrow(
      "Choose a repository",
    );
    expect(api.onboardMuse).not.toHaveBeenCalled();
    await authorizeExecutionAgent(api, "project", " owner/repository ", true);
    expect(api.onboardMuse).toHaveBeenCalledTimes(1);
    expect(api.onboardMuse).toHaveBeenCalledWith("project", "owner/repository");
  });
  it("propagates backend denial without reporting successful authorization", async () => {
    const api = { onboardMuse: vi.fn().mockRejectedValue(new Error("Admin approval required.")) };
    await expect(authorizeExecutionAgent(api, "project", "owner/repository", true)).rejects.toThrow(
      "Admin approval required.",
    );
  });
});
