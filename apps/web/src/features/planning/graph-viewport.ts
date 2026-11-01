import type { GraphBounds } from "./graph-layout.js";

export const BASE_ZOOM = 65;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 2;
export interface GraphView {
  readonly centerX: number;
  readonly centerY: number;
  readonly scale: number;
}
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export function panView(view: GraphView, deltaX: number, deltaY: number): GraphView {
  return {
    ...view,
    centerX: view.centerX + deltaX / view.scale,
    centerY: view.centerY + deltaY / view.scale,
  };
}

export function zoomView(view: GraphView, multiplier: number, anchorX = 0, anchorY = 0): GraphView {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * multiplier));
  return {
    scale,
    centerX: view.centerX + anchorX / view.scale - anchorX / scale,
    centerY: view.centerY + anchorY / view.scale - anchorY / scale,
  };
}

export function fitView(bounds: GraphBounds, viewport: ViewportSize, initial = false): GraphView {
  const availableWidth = Math.max(1, viewport.width - 120);
  const availableHeight = Math.max(1, viewport.height - 160);
  return {
    centerX: (bounds.left + bounds.right) / 2,
    centerY: (bounds.top + bounds.bottom) / 2,
    scale: Math.max(
      initial ? 0.7 : MIN_SCALE,
      Math.min(
        1,
        availableWidth / Math.max(1, bounds.right - bounds.left),
        availableHeight / Math.max(1, bounds.bottom - bounds.top),
      ),
    ),
  };
}
