import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExecutionOutcomeNotice } from "./ExecutionOutcomeNotice.js";
import type { ExecutionStep } from "../intent/intent-api.js";

// Only the authoritative state is needed to render the completed outcome.
const step = { state: "COMPLETED" } as ExecutionStep;
describe("execution notification dismissal", () => {
  it("offers a labeled keyboard-accessible dismiss button when enabled by the header", () => {
    const markup = renderToStaticMarkup(<ExecutionOutcomeNotice step={step} onDismiss={vi.fn()} />);
    expect(markup).toContain('aria-label="Dismiss execution notification"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Work item completed.");
  });
  it("preserves the persistent outcome notice in work item details", () => {
    const markup = renderToStaticMarkup(<ExecutionOutcomeNotice step={step} />);
    expect(markup).not.toContain("Dismiss execution notification");
    expect(markup).toContain("Work item completed.");
  });
});
