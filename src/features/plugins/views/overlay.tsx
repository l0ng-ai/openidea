/**
 * Plugin overlays (`[[contributes.overlays]]`): a web page floating over the workbench at one
 * of nine anchors while its `when` holds — a mascot, a reaction, a timer. The frame never takes
 * the keyboard focus (it is out of the tab order and never focused when it appears), sits under
 * dialogs, popups and notifications, and with `interactive = false` lets every click through.
 * Through `openidea.overlay` the page moves itself to another anchor and resizes itself to fit
 * what it shows.
 */
import { useMemo, useRef, useState } from "react";
import { evaluateWhen, useContextKeys } from "@/platform/context";
import { registerOverlay } from "@/workbench/contributions";
import { WebView, type FrameOverlay, type OverlayPlacement } from "./WebView";
import styles from "./overlay.module.css";

export interface OverlayDecl {
  id: string;
  web: string;
  /** Pixels, 40–800 (checked by the backend). */
  width: number;
  height: number;
  /** One of {@link OVERLAY_ANCHORS} (checked by the backend). */
  anchor: string;
  when?: string | null;
  interactive: boolean;
}

export const OVERLAY_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

const MIN_SIZE = 40;
const MAX_SIZE = 800;

/** `args` applied to `current`: the placement a page asked for, or why it can't have it. */
export function placeOverlay(current: OverlayPlacement, args: Record<string, unknown>): OverlayPlacement {
  const next = { ...current };
  if (args.anchor !== undefined) {
    if (!OVERLAY_ANCHORS.includes(args.anchor as (typeof OVERLAY_ANCHORS)[number]))
      throw new Error(`anchor is one of ${OVERLAY_ANCHORS.join(", ")}`);
    next.anchor = args.anchor as string;
  }
  for (const key of ["width", "height"] as const) {
    const v = args[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
    next[key] = Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, v)));
  }
  return next;
}

function PluginOverlay({ pluginId, decl }: { pluginId: string; decl: OverlayDecl }) {
  const [placement, setPlacement] = useState<OverlayPlacement>(() => ({
    anchor: decl.anchor,
    width: decl.width,
    height: decl.height,
  }));
  // The frame's requests read the latest placement without re-creating its message handling.
  const latest = useRef(placement);
  latest.current = placement;
  const overlay = useMemo<FrameOverlay>(
    () => ({
      get: () => latest.current,
      place: (args) => {
        const next = placeOverlay(latest.current, args);
        latest.current = next;
        setPlacement(next);
        return next;
      },
    }),
    [],
  );
  const [v, h] = placement.anchor === "center" ? ["middle", "center"] : placement.anchor.split("-");
  return (
    <div
      className={styles.overlay}
      data-plugin-overlay={`${pluginId}/${decl.id}`}
      data-v={v}
      data-h={h}
      data-interactive={decl.interactive}
      style={{ width: placement.width, height: placement.height }}
    >
      <WebView pluginId={pluginId} view={decl.id} label={decl.id} overlay={overlay} />
    </div>
  );
}

/** Floats the overlay over the workbench while its `when` holds. */
export function projectOverlay(pluginId: string, decl: OverlayDecl): () => void {
  function Overlay() {
    return <PluginOverlay pluginId={pluginId} decl={decl} />;
  }
  let remove: (() => void) | null = null;
  const refresh = () => {
    const show = evaluateWhen(decl.when ?? undefined);
    if (show === !!remove) return;
    if (show) remove = registerOverlay({ id: `plugin.${pluginId}.${decl.id}`, component: Overlay });
    else {
      remove?.();
      remove = null;
    }
  };
  const offContext = useContextKeys.subscribe(refresh);
  refresh();
  return () => {
    offContext();
    remove?.();
  };
}
