/**
 * Image editor kind (IDEA's image viewer): zoom in / out / fit / actual size,
 * ⌘/Ctrl+wheel zoom, transparency chessboard, dimensions and file size.
 * Images are read by the backend as `data:` URLs (the CSP allows those).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import clsx from "clsx";
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { IconButton, T } from "@/ui";
import { formatSize, isSvgPath } from "./fileKinds";
import { clampZoom, fitZoom, initialZoom, stepZoom, zoomAt, zoomLabel, type View } from "./imageZoom";
import { useForwardFocus } from "./forwardFocus";
import styles from "./Viewers.module.css";
import { tx } from "@/platform/i18n";

export interface ImageViewerHandle {
  zoom(dir: 1 | -1): void;
  actualSize(): void;
  fit(): void;
}

const CHESSBOARD_KEY = "openidea.imageViewer.chessboard";

function storedChessboard(): boolean {
  try {
    return localStorage.getItem(CHESSBOARD_KEY) !== "false";
  } catch {
    return true;
  }
}

interface ImageViewerState {
  /** The focused (or last focused) viewer, target of the image.* actions. */
  active: ImageViewerHandle | null;
  chessboard: boolean;
}

export const useImageViewers = create<ImageViewerState>(() => ({ active: null, chessboard: storedChessboard() }));

export function toggleChessboard() {
  const chessboard = !useImageViewers.getState().chessboard;
  useImageViewers.setState({ chessboard });
  try {
    localStorage.setItem(CHESSBOARD_KEY, String(chessboard));
  } catch {
    // Per-viewer convenience only.
  }
}

const PADDING = 32;

export function ImageViewer({ input }: { input: EditorInput }) {
  const path = input.path!;
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [reload, setReload] = useState(0);
  const chessboard = useImageViewers((s) => s.chessboard);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([call(commands.fsReadImage(path)), call(commands.fsProbe(path))])
      .then(([url, probe]) => {
        if (!live) return;
        setSrc(url);
        setSize(probe.size);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [path, reload]);

  const available = useCallback(() => {
    const el = canvasRef.current;
    return el ? { w: el.clientWidth - PADDING, h: el.clientHeight - PADDING } : { w: 0, h: 0 };
  }, []);

  const centered = useCallback(
    (z: number): View => {
      const el = canvasRef.current;
      const w = (natural?.w ?? 0) * z;
      const h = (natural?.h ?? 0) * z;
      return { z, x: ((el?.clientWidth ?? 0) - w) / 2, y: ((el?.clientHeight ?? 0) - h) / 2 };
    },
    [natural],
  );

  const handle: ImageViewerHandle = useMemo(
    () => ({
      zoom: (dir) =>
        setView((v) => {
          const el = canvasRef.current;
          if (!v || !el) return v;
          return zoomAt(v, stepZoom(v.z, dir), el.clientWidth / 2, el.clientHeight / 2);
        }),
      actualSize: () => setView(centered(1)),
      fit: () => {
        if (!natural) return;
        const a = available();
        setView(centered(fitZoom(natural.w, natural.h, a.w, a.h)));
      },
    }),
    [natural, available, centered],
  );

  // The viewer of the active tab is the actions' target as soon as it is shown.
  useLayoutEffect(() => {
    useImageViewers.setState({ active: handle });
    setContext("imageViewerActive", true);
    return () => {
      if (useImageViewers.getState().active !== handle) return;
      useImageViewers.setState({ active: null });
      setContext("imageViewerActive", false);
      setContext("imageViewerFocus", false);
    };
  }, [handle]);

  useForwardFocus(rootRef);

  const onLoad = (img: HTMLImageElement) => {
    // SVGs without intrinsic size report 0×0; show them at a usable size.
    const w = img.naturalWidth || 300;
    const h = img.naturalHeight || 150;
    setNatural({ w, h });
    const a = available();
    const el = canvasRef.current;
    const z = initialZoom(w, h, a.w, a.h);
    setView((v) => v ?? { z, x: ((el?.clientWidth ?? 0) - w * z) / 2, y: ((el?.clientHeight ?? 0) - h * z) / 2 });
  };

  // Native listener: React's wheel handler is passive, so preventDefault would be ignored.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.metaKey || e.ctrlKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 0 ? 0.01 : 0.33));
        setView((v) => v && zoomAt(v, clampZoom(v.z * factor), e.clientX - rect.left, e.clientY - rect.top));
      } else {
        setView((v) => v && { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [error, src]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setView((v) => v && { ...v, x: v.x + dx, y: v.y + dy });
  };
  const endDrag = (e: ReactPointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const z = view?.z ?? 1;
  const svg = isSvgPath(path);
  const info = [natural && `${natural.w}×${natural.h}`, size !== null && formatSize(size), view && zoomLabel(z)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      ref={rootRef}
      className={styles.root}
      tabIndex={-1}
      onFocus={() => {
        useImageViewers.setState({ active: handle });
        setContext("imageViewerFocus", true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setContext("imageViewerFocus", false);
      }}
    >
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Image viewer")}>
        <IconButton icon="zoom-in" size="small" action="image.zoomIn" />
        <IconButton icon="zoom-out" size="small" action="image.zoomOut" />
        <IconButton icon="actual-size" size="small" action="image.actualSize" />
        <IconButton icon="maximize" size="small" action="image.fitToWindow" />
        <div className={styles.separator} />
        <IconButton icon="chessboard" size="small" action="image.toggleChessboard" pressed={chessboard} />
        <IconButton
          icon="refresh"
          size="small"
          title="Reload from Disk"
          onClick={() => {
            setError(null);
            setReload((n) => n + 1);
          }}
        />
        <div className={styles.spacer} />
        <span className={styles.info}>{info}</span>
        {svg && (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => void editorService().openFile(path, { asText: true })}
          >
            <T>Open as Text</T>
          </button>
        )}
      </div>
      {error ? (
        <div className={styles.message}>{tx`Cannot show the image: ${error}`}</div>
      ) : (
        <div
          ref={canvasRef}
          className={clsx(styles.canvas, dragging && styles.dragging)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {src && (
            <img
              src={src}
              alt={path.slice(path.lastIndexOf("/") + 1)}
              draggable={false}
              className={clsx(styles.image, chessboard && styles.chessboard, z >= 4 && styles.pixelated)}
              style={
                natural && view
                  ? {
                      width: natural.w,
                      height: natural.h,
                      transform: `translate(${view.x}px, ${view.y}px) scale(${z})`,
                    }
                  : { visibility: "hidden" }
              }
              onLoad={(e) => onLoad(e.currentTarget)}
              onError={() => setError("the file is not a valid image")}
            />
          )}
        </div>
      )}
    </div>
  );
}
