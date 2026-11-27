import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "zustand";
import { onEditorEvent } from "@/editor/api";
import { isSvgPath } from "@/features/viewers/fileKinds";
import { useForwardFocus } from "@/features/viewers/forwardFocus";
import { useT, useTx } from "@/platform/i18n";
import { Button, IconButton, Select, T } from "@/ui";
import { useEditorDocuments } from "@/workbench/contributions";
import { emptyStagedStatus, stagedDiffPath, stagedDocumentAtPath } from "./stagedDocument";
import { sideFile, sideLabel, type DiffData } from "./diffInput";
import { loadImageFrames, type ImageFrame } from "./imageDiffFrames";
import { canComparePixels, imageBounds, paintPixelDifference, type ImageSize } from "./imagePixels";
import { useVcs } from "./store";
import styles from "./ImageDiff.module.css";

function frameSize(frame: ImageFrame) {
  return frame.kind === "ready" ? [frame.size] : [];
}

function Pane({ label, detail, children }: { label: string; detail?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.pane} aria-label={label}>
      <div className={styles.heading}>
        <strong title={label}>{label}</strong>
        {detail && <span>{detail}</span>}
      </div>
      <div className={styles.surface} data-wheel-scroll>
        {children}
      </div>
    </section>
  );
}

function imageStyle(size: ImageSize, bounds: ImageSize): CSSProperties {
  return { width: (100 * size.width) / bounds.width + "%", height: (100 * size.height) / bounds.height + "%" };
}

function PixelDifference({ before, after, bounds }: { before: ImageFrame; after: ImageFrame; bounds: ImageSize }) {
  const tx = useTx();
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<number | "error" | null>(null);
  const extent = imageBounds([...frameSize(before), ...frameSize(after)]);
  const empty = before.kind === "absent" && after.kind === "absent";
  const comparable = before.kind !== "error" && after.kind !== "error" && canComparePixels(extent);
  useEffect(() => {
    const mask = canvas.current;
    if (!mask || !comparable) return;
    try {
      mask.width = extent.width;
      mask.height = extent.height;
      const ctx = mask.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas unavailable");
      const pixels = (frame: ImageFrame) => {
        if (frame.kind !== "ready") return null;
        const { width, height } = frame.size;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(frame.image, 0, 0);
        return ctx.getImageData(0, 0, width, height);
      };
      const left = pixels(before);
      const right = pixels(after);
      const out = ctx.createImageData(extent.width, extent.height);
      const count = paintPixelDifference(left, right, out);
      ctx.putImageData(out, 0, 0);
      setResult(count);
    } catch {
      setResult("error");
    }
    return () => {
      mask.width = mask.height = 0;
    };
  }, [before, after, comparable, extent.width, extent.height]);
  const message =
    before.kind === "error" || after.kind === "error" || result === "error"
      ? tx("Pixel differences unavailable")
      : empty
        ? tx("No images to compare")
        : !comparable
          ? tx("Image dimensions exceed the pixel comparison limit")
          : null;
  const count = empty ? 0 : result;
  return (
    <Pane
      label={tx("Changed pixels")}
      detail={<span role="status">{typeof count === "number" && t("vcs.imageDiff.changedPixels", { count })}</span>}
    >
      {message ? (
        <span className={styles.message}>{message}</span>
      ) : (
        <div className={styles.plane}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={tx("Pixel difference mask")}
            className={styles.art}
            style={imageStyle(extent, bounds)}
          />
        </div>
      )}
    </Pane>
  );
}

export function ImageDiff({
  data,
  onSource,
  toolbarActions,
  forwardFocus = false,
}: {
  data: DiffData;
  onSource?: () => void;
  toolbarActions?: ReactNode;
  forwardFocus?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  useForwardFocus(root);
  const tx = useTx();
  const { left, middle, right, path } = data;
  const sides = useMemo(() => (middle ? [left, middle, right] : [left, right]), [left, middle, right]);
  const immutable = sides.every(
    (side) => side.type === "text" || (side.type === "rev" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(side.rev)),
  );
  const version = useVcs((s) => (immutable ? 0 : s.version));
  const stagedPath = stagedDiffPath(data);
  const indexDoc = useEditorDocuments(() =>
    stagedPath && isSvgPath(stagedPath) ? stagedDocumentAtPath(stagedPath) : undefined,
  );
  const stagedDraft = useStore(indexDoc?.status ?? emptyStagedStatus, (s) =>
    s.base && s.text !== s.base.text ? s.text : null,
  );
  const [documentVersion, setDocumentVersion] = useState(0);
  useEffect(() => {
    const files = sides.map((side) => sideFile(side, path));
    if (!files.some(Boolean)) return;
    return onEditorEvent((e) => {
      if ((e.type === "docSaved" || (e.type === "docChanged" && isSvgPath(e.path))) && files.includes(e.path))
        setDocumentVersion((n) => n + 1);
    });
  }, [path, sides]);

  const request = useMemo(
    () => ({ path, sides, version, documentVersion, stagedDraft }),
    [path, sides, version, documentVersion, stagedDraft],
  );
  const [loaded, setLoaded] = useState<{ request: typeof request; frames: ImageFrame[] }>();
  useEffect(() => {
    let cancelled = false;
    void loadImageFrames(request.path, request.sides, () => cancelled).then((frames) => {
      if (!cancelled) setLoaded({ request, frames });
    });
    return () => {
      cancelled = true;
    };
  }, [request]);
  const frames = loaded?.request === request ? loaded.frames : undefined;
  const labels = sides.map((side) => tx(sideLabel(side)));
  const [highlight, setHighlight] = useState(false);
  const [fit, setFit] = useState(true);
  const [pair, setPair] = useState("0-1");
  const pairs: readonly (readonly [number, number])[] = middle
    ? [
        [0, 1],
        [1, 2],
        [0, 2],
      ]
    : [[0, 1]];
  const selected = pairs.find((p) => p.join("-") === pair) ?? pairs[0]!;
  const visible = highlight ? selected : sides.map((_, i) => i);
  const bounds = imageBounds(visible.flatMap((i) => (frames?.[i] ? frameSize(frames[i]!) : [])));
  const hasImage = frames?.some((frame) => frame.kind === "ready");

  return (
    <div ref={forwardFocus ? root : undefined} tabIndex={-1} className={styles.root}>
      <div role="toolbar" aria-label={tx("Image diff")} className={styles.toolbar}>
        <Button
          size="small"
          variant="ghost"
          aria-pressed={highlight}
          disabled={!hasImage && !highlight}
          onClick={() => {
            setHighlight(!highlight);
            if (!highlight) setFit(false);
          }}
        >
          Highlight changed pixels
        </Button>
        {highlight && middle && (
          <Select
            value={pair}
            options={pairs.map(([a, b]) => ({
              value: [a, b].join("-"),
              label: labels[a] + " ↔ " + labels[b],
              verbatim: true,
            }))}
            aria-label="Compare revisions"
            onChange={setPair}
          />
        )}
        <span className={styles.separator} />
        <IconButton icon="actual-size" size="small" title="Actual Size" pressed={!fit} onClick={() => setFit(false)} />
        <IconButton icon="maximize" size="small" title="Fit to Window" pressed={fit} onClick={() => setFit(true)} />
        {onSource && (
          <Button size="small" variant="ghost" onClick={onSource}>
            View source diff
          </Button>
        )}
        <div className={styles.actions}>{toolbarActions}</div>
      </div>
      <div
        className={styles.panes}
        data-fit={fit || undefined}
        style={
          {
            "--plane-width": (bounds.width || 1) + "px",
            "--plane-ratio": (bounds.width || 1) / (bounds.height || 1),
          } as CSSProperties
        }
      >
        {visible.map((i) => {
          const frame = frames?.[i];
          const dimensions = frame?.kind === "ready" && frame.intrinsic.width + " × " + frame.intrinsic.height;
          return (
            <Pane key={i} label={labels[i]!} detail={dimensions}>
              {frame?.kind === "ready" ? (
                <div className={styles.plane}>
                  <img
                    src={frame.image.src}
                    alt={labels[i]!}
                    draggable={false}
                    className={styles.art}
                    style={imageStyle(frame.size, bounds)}
                  />
                </div>
              ) : (
                <span className={styles.message}>
                  {!frame ? (
                    <T>Loading…</T>
                  ) : frame.kind === "absent" ? (
                    <T>No image on this side</T>
                  ) : (
                    tx`Cannot show the image: ${frame.error}`
                  )}
                </span>
              )}
            </Pane>
          );
        })}
        {highlight && frames && hasImage && (
          <PixelDifference
            key={selected.join("-")}
            before={frames[selected[0]]!}
            after={frames[selected[1]]!}
            bounds={bounds}
          />
        )}
      </div>
    </div>
  );
}
