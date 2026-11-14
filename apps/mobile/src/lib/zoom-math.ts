/**
 * Pure pinch/pan maths for ZoomableImage, kept free of React and Reanimated
 * so it can run as worklets and be exercised outside the app.
 *
 * Coordinates are offsets from the frame's centre (the transform origin).
 * The image is drawn as translate(tx, ty) then scale(s), so a content point q
 * appears at t + s * q.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;

export type Transform = { s: number; tx: number; ty: number };

export type PinchAnchor = {
  /** Scale the gesture's cumulative `scale` is applied to. */
  baseScale: number;
  /** Content point (unscaled) that stays under the fingers. */
  ax: number;
  ay: number;
  /** Pointer count the anchor was taken with; a change re-anchors. */
  pointers: number;
};

/** Translation limit that keeps a frame-filling image covering the frame. */
export const clampOffset = ({
  value,
  scale,
  size,
}: {
  value: number;
  scale: number;
  size: number;
}): number => {
  "worklet";
  const max = Math.max(0, ((scale - 1) * size) / 2);
  return Math.min(Math.max(value, -max), max);
};

/**
 * One pinch update. Re-anchors whenever the pointer count changes (a finger
 * lands or lifts), so the focal point moving to the remaining finger doesn't
 * fling the image. With fewer than two pointers it holds the transform.
 */
export const pinchStep = ({
  current,
  anchor,
  gestureScale,
  fx,
  fy,
  pointers,
}: {
  current: Transform;
  anchor: PinchAnchor | null;
  gestureScale: number;
  fx: number;
  fy: number;
  pointers: number;
}): { transform: Transform; anchor: PinchAnchor | null } => {
  "worklet";
  if (pointers < 2) return { transform: current, anchor: null };
  let a = anchor;
  if (!a || a.pointers !== pointers) {
    a = {
      baseScale: current.s / gestureScale,
      ax: (fx - current.tx) / current.s,
      ay: (fy - current.ty) / current.s,
      pointers,
    };
  }
  const s = Math.min(
    Math.max(a.baseScale * gestureScale, MIN_SCALE * 0.8),
    MAX_SCALE,
  );
  return { transform: { s, tx: fx - s * a.ax, ty: fy - s * a.ay }, anchor: a };
};

/** Where a transform settles after a gesture: back to 1 or clamped in bounds. */
export const settle = ({
  current,
  width,
  height,
}: {
  current: Transform;
  width: number;
  height: number;
}): Transform => {
  "worklet";
  if (current.s <= MIN_SCALE) return { s: 1, tx: 0, ty: 0 };
  return {
    s: current.s,
    tx: clampOffset({ value: current.tx, scale: current.s, size: width }),
    ty: clampOffset({ value: current.ty, scale: current.s, size: height }),
  };
};

/** Double-tap target: zoom in so the tapped point stays put, or reset. */
export const doubleTapTarget = ({
  current,
  fx,
  fy,
  zoomScale,
  width,
  height,
}: {
  current: Transform;
  fx: number;
  fy: number;
  zoomScale: number;
  width: number;
  height: number;
}): Transform => {
  "worklet";
  if (current.s > MIN_SCALE) return { s: 1, tx: 0, ty: 0 };
  return settle({
    current: { s: zoomScale, tx: fx - zoomScale * fx, ty: fy - zoomScale * fy },
    width,
    height,
  });
};
