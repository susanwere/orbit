import { useThree } from "@react-three/fiber";
import { useEffect, useImperativeHandle, useRef, type Ref, type RefObject } from "react";
import { OrthographicCamera } from "three";
import type { GraphBounds } from "./graph-layout.js";
import { BASE_ZOOM, fitView, panView, zoomView, type GraphView } from "./graph-viewport.js";

export interface GraphViewportControls {
  zoomBy: (multiplier: number) => void;
  fit: () => void;
  reset: () => void;
  reveal: (x: number, y: number, width: number, height: number) => void;
}
interface Props {
  readonly bounds: GraphBounds;
  readonly sceneRef: RefObject<HTMLDivElement>;
  readonly controlsRef: Ref<GraphViewportControls>;
  readonly isPanningEnabled: boolean;
  readonly onScaleChange: (scale: number) => void;
}

/** The camera owns navigation; refreshing execution evidence never replaces the user's view. */
export function GraphViewport({
  bounds,
  sceneRef,
  controlsRef,
  isPanningEnabled,
  onScaleChange,
}: Props) {
  const { camera, size, invalidate } = useThree();
  const viewRef = useRef<GraphView>({ centerX: 0, centerY: 0, scale: 1 });
  const userNavigated = useRef(false);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  function applyView(view: GraphView) {
    if (!(camera instanceof OrthographicCamera)) return;
    viewRef.current = view;
    camera.position.set(view.centerX / BASE_ZOOM, -view.centerY / BASE_ZOOM, 30);
    camera.zoom = view.scale * BASE_ZOOM;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const scene = sceneRef.current;
    if (scene) {
      scene.dataset.viewCenterX = String(view.centerX);
      scene.dataset.viewCenterY = String(view.centerY);
      scene.dataset.viewScale = String(view.scale);
    }
    onScaleChange(view.scale);
    invalidate();
  }
  const applyViewRef = useRef(applyView);
  applyViewRef.current = applyView;

  useImperativeHandle(
    controlsRef,
    () => ({
      reveal(x, y, width, height) {
        const view = viewRef.current;
        const viewport = sizeRef.current;
        const visibleWidth = viewport.width / view.scale;
        const visibleHeight = viewport.height / view.scale;
        if (
          Math.abs(x - view.centerX) + width / 2 > visibleWidth / 2 - 24 ||
          Math.abs(y - view.centerY) + height / 2 > visibleHeight / 2 - 24
        ) {
          userNavigated.current = true;
          applyViewRef.current({ ...view, centerX: x, centerY: y });
        }
      },
      zoomBy(multiplier) {
        userNavigated.current = true;
        applyViewRef.current(zoomView(viewRef.current, multiplier));
      },
      fit() {
        userNavigated.current = true;
        applyViewRef.current(fitView(boundsRef.current, sizeRef.current));
      },
      reset() {
        userNavigated.current = true;
        applyViewRef.current({ ...fitView(boundsRef.current, sizeRef.current), scale: 1 });
      },
    }),
    [],
  );

  useEffect(() => {
    if (!userNavigated.current) applyViewRef.current(fitView(bounds, size, true));
    // A resized viewport preserves the current world center and zoom after navigation.
    else applyViewRef.current(viewRef.current);
  }, [bounds.left, bounds.right, bounds.top, bounds.bottom, size.width, size.height]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    let drag: { pointerId: number; x: number; y: number } | null = null;
    function pointerDown(event: PointerEvent) {
      if (
        !isPanningEnabled ||
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        event.target.closest("button, a, input, textarea, summary, [role=toolbar]")
      )
        return;
      event.preventDefault();
      scene!.focus({ preventScroll: true });
      scene!.setPointerCapture(event.pointerId);
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      scene!.classList.add("is-dragging");
    }
    function pointerMove(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      userNavigated.current = true;
      applyViewRef.current(
        panView(viewRef.current, drag.x - event.clientX, drag.y - event.clientY),
      );
      drag = { ...drag, x: event.clientX, y: event.clientY };
    }
    function pointerUp(event: PointerEvent) {
      if (drag?.pointerId !== event.pointerId) return;
      drag = null;
      scene!.classList.remove("is-dragging");
      if (scene!.hasPointerCapture(event.pointerId)) scene!.releasePointerCapture(event.pointerId);
    }
    function wheel(event: WheelEvent) {
      if (event.target instanceof Element && event.target.closest("[role=toolbar]")) return;
      event.preventDefault();
      userNavigated.current = true;
      if (event.ctrlKey || event.metaKey) {
        const rectangle = scene!.getBoundingClientRect();
        applyViewRef.current(
          zoomView(
            viewRef.current,
            Math.exp(-event.deltaY * 0.01),
            event.clientX - rectangle.left - rectangle.width / 2,
            event.clientY - rectangle.top - rectangle.height / 2,
          ),
        );
      } else if (isPanningEnabled) {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scene!.clientHeight : 1;
        applyViewRef.current(
          panView(
            viewRef.current,
            (event.deltaX + (event.shiftKey ? event.deltaY : 0)) * unit,
            (event.shiftKey ? 0 : event.deltaY) * unit,
          ),
        );
      }
    }
    function keyDown(event: KeyboardEvent) {
      if (event.target !== scene) return;
      const arrowDeltas: Record<string, [number, number]> = {
        ArrowLeft: [-64, 0],
        ArrowRight: [64, 0],
        ArrowUp: [0, -64],
        ArrowDown: [0, 64],
      };
      const delta = arrowDeltas[event.key];
      if (!delta && !["+", "=", "-", "0", "Home"].includes(event.key)) return;
      event.preventDefault();
      userNavigated.current = true;
      if (delta) applyViewRef.current(panView(viewRef.current, ...delta));
      else if (event.key === "0") applyViewRef.current(fitView(boundsRef.current, sizeRef.current));
      else if (event.key === "Home")
        applyViewRef.current({ ...fitView(boundsRef.current, sizeRef.current), scale: 1 });
      else applyViewRef.current(zoomView(viewRef.current, event.key === "-" ? 1 / 1.2 : 1.2));
    }
    scene.addEventListener("pointerdown", pointerDown);
    scene.addEventListener("pointermove", pointerMove);
    scene.addEventListener("pointerup", pointerUp);
    scene.addEventListener("pointercancel", pointerUp);
    scene.addEventListener("lostpointercapture", pointerUp);
    scene.addEventListener("wheel", wheel, { passive: false });
    scene.addEventListener("keydown", keyDown);
    return () => {
      scene.classList.remove("is-dragging");
      scene.removeEventListener("pointerdown", pointerDown);
      scene.removeEventListener("pointermove", pointerMove);
      scene.removeEventListener("pointerup", pointerUp);
      scene.removeEventListener("pointercancel", pointerUp);
      scene.removeEventListener("lostpointercapture", pointerUp);
      scene.removeEventListener("wheel", wheel);
      scene.removeEventListener("keydown", keyDown);
    };
  }, [isPanningEnabled, sceneRef]);
  return null;
}
