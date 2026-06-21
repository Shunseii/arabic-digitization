import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Centered, Loading } from "./ui";

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 1;
const MAX_SCALE = 5;

/**
 * The original scan with scroll-wheel zoom, click-drag pan, and double-click
 * reset — the desktop analogue of the mobile reader's pinch-to-zoom pane.
 * Fetches the image through the authed API and wraps it in a blob URL.
 */
export const ZoomableImage = ({
  bookId,
  fileId,
}: {
  bookId: string;
  fileId: string;
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [t, setT] = useState<Transform>(IDENTITY);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    setT(IDENTITY);
    api
      .fetchImageObjectUrl({ bookId, fileId })
      .then((u) => {
        if (!active) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setUrl(u);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId, fileId]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setT((prev) => {
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, prev.scale - e.deltaY * 0.002),
      );
      if (next === MIN_SCALE) return IDENTITY;
      return { ...prev, scale: next };
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (t.scale === 1) return;
    dragging.current = { x: e.clientX - t.x, y: e.clientY - t.y };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current) return;
    setT((prev) => ({
      ...prev,
      x: e.clientX - (dragging.current?.x ?? 0),
      y: e.clientY - (dragging.current?.y ?? 0),
    }));
  };
  const endDrag = () => {
    dragging.current = null;
  };

  if (failed)
    return (
      <Centered>
        <p className="text-sm text-text-secondary">
          Couldn't load the scanned image.
        </p>
      </Centered>
    );
  if (!url) return <Loading />;

  return (
    <button
      type="button"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onDoubleClick={() => setT(IDENTITY)}
      className="flex h-full w-full items-center justify-center overflow-hidden bg-transparent p-0"
      style={{ cursor: t.scale > 1 ? "grab" : "zoom-in" }}
    >
      <img
        src={url}
        alt="Scanned page"
        draggable={false}
        className="max-h-full max-w-full select-none object-contain"
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transition: dragging.current ? "none" : "transform 120ms ease-out",
        }}
      />
    </button>
  );
};
