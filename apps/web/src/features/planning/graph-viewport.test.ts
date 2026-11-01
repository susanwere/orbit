import { describe, expect, it } from "vitest";
import { fitView, panView, zoomView } from "./graph-viewport.js";

describe("camera viewport geometry", () => {
  it.each([0.05, 0.7, 1, 2])("pans in both axes at scale %s", (scale) => {
    const view = { centerX: 100, centerY: 200, scale };
    const moved = panView(view, 70, -50);
    expect((moved.centerX - view.centerX) * scale).toBeCloseTo(70);
    expect((moved.centerY - view.centerY) * scale).toBeCloseTo(-50);
  });
  it("keeps the world point under the cursor stable when zooming", () => {
    const view = { centerX: 300, centerY: 200, scale: 0.8 };
    const zoomed = zoomView(view, 1.2, 150, -80);
    expect(zoomed.centerX + 150 / zoomed.scale).toBeCloseTo(view.centerX + 150 / view.scale);
    expect(zoomed.centerY - 80 / zoomed.scale).toBeCloseTo(view.centerY - 80 / view.scale);
  });
  it.each([
    [1366, 768],
    [1920, 1080],
  ])("fits full bounds with padding at %s by %s", (width, height) => {
    const bounds = { left: -100, top: -300, right: 2200, bottom: 1100 };
    const view = fitView(bounds, { width, height });
    expect(view.centerX).toBe(1050);
    expect(view.centerY).toBe(400);
    expect((bounds.right - bounds.left) * view.scale).toBeLessThanOrEqual(width - 120);
    expect((bounds.bottom - bounds.top) * view.scale).toBeLessThanOrEqual(height - 160);
  });
  it("uses a readable initial zoom for very large graphs; explicit fit can zoom out further", () => {
    const bounds = { left: 0, top: 0, right: 12000, bottom: 5000 };
    expect(fitView(bounds, { width: 1366, height: 768 }, true).scale).toBe(0.7);
    expect(fitView(bounds, { width: 1366, height: 768 }).scale).toBeLessThan(0.7);
  });
  it("recomputes fit for resized viewports without changing graph coordinates", () => {
    const bounds = { left: 0, top: 0, right: 1600, bottom: 800 };
    expect(fitView(bounds, { width: 1920, height: 1080 }).scale).toBeGreaterThan(
      fitView(bounds, { width: 1366, height: 768 }).scale,
    );
  });
});
