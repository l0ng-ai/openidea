import { useEffect, type CSSProperties, type RefObject } from "react";
import { create } from "zustand";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { registerFontZoomSurface, useEditorShown, useEditorTabId, useToolWindowShown } from "@/workbench/contributions";

const MIN_FONT_ZOOM = -6;
const MAX_FONT_ZOOM = 36;
const DEFAULT_UI_FONT_SIZE = 13;

export const useAgentFontZoom = create<{ bySurface: Record<string, number> }>(() => ({ bySurface: {} }));

export function agentSurfaceZoomKey(fallbackKey: string, docked: boolean, tabId: string | null): string {
  if (docked) return `docked:${fallbackKey}`;
  return tabId ? `tab:${tabId}` : fallbackKey;
}

/** Steps one Agent chat surface's font zoom by `delta` px (-6..36), or resets it when `delta === 0`. */
export function stepAgentSurfaceFontZoom(surfaceKey: string, delta: number): void {
  useAgentFontZoom.setState((s) => {
    const current = s.bySurface[surfaceKey] ?? 0;
    const next = delta === 0 ? 0 : Math.max(MIN_FONT_ZOOM, Math.min(MAX_FONT_ZOOM, current + delta));
    if (next === current) return s;
    if (next === 0) {
      const { [surfaceKey]: _, ...rest } = s.bySurface;
      return { bySurface: rest };
    }
    return { bySurface: { ...s.bySurface, [surfaceKey]: next } };
  });
}

export function clearAgentTabFontZoom(tabId: string): void {
  stepAgentSurfaceFontZoom(`tab:${tabId}`, 0);
}

export function clearAgentTaskFontZoom(taskKey: string): void {
  useAgentFontZoom.setState((s) => {
    const dockedKey = `docked:${taskKey}`;
    if (!(taskKey in s.bySurface) && !(dockedKey in s.bySurface)) return s;
    const { [taskKey]: _a, [dockedKey]: _b, ...rest } = s.bySurface;
    return { bySurface: rest };
  });
}

export function resetAllAgentFontZoom(): void {
  useAgentFontZoom.setState({ bySurface: {} });
}

function uiFontSizeOf(settings: unknown): number {
  if (!settings || typeof settings !== "object") return DEFAULT_UI_FONT_SIZE;
  const a = (settings as { appearance?: { useCustomFont?: unknown; uiFontSize?: unknown } }).appearance;
  return a?.useCustomFont && typeof a.uiFontSize === "number" && a.uiFontSize > 0 ? a.uiFontSize : DEFAULT_UI_FONT_SIZE;
}

/**
 * Wires per-tab keyboard font zoom (`editor.increaseFontSize` / `decreaseFontSize` / `resetFontSize`)
 * and `⌘/Ctrl+wheel` (when `editor.general.wheelZoom` is on) to an Agent chat surface.
 */
export function useAgentFontZoomSurface(
  ref: RefObject<HTMLElement | null>,
  fallbackKey: string,
  docked: boolean,
  enabled = true,
): { fontZoom: number; zoomStyle: CSSProperties } {
  const editorShown = useEditorShown();
  const toolWindowShown = useToolWindowShown();
  const tabId = useEditorTabId();
  const surfaceKey = agentSurfaceZoomKey(fallbackKey, docked, tabId);
  const active = enabled && (docked ? toolWindowShown : editorShown);
  const fontZoom = useAgentFontZoom((s) => s.bySurface[surfaceKey] ?? 0);
  const baseSize = useProject((s) => uiFontSizeOf(s.settings));
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const step = (delta: number) => stepAgentSurfaceFontZoom(surfaceKey, delta);
    const onWheel = (e: WheelEvent) => {
      if ((!e.ctrlKey && !e.metaKey) || e.deltaY === 0 || !editorPrefs().general.wheelZoom) return;
      e.preventDefault();
      e.stopPropagation();
      step(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    const release = registerFontZoomSurface(el, step, { isolated: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      release();
    };
  }, [ref, active, surfaceKey]);
  const zoomScale = Number((Math.max(4, baseSize + fontZoom) / baseSize).toFixed(4));
  const zoomStyle = {
    "--agent-font-zoom": `${fontZoom}px`,
    "--markdown-zoom-scale": String(zoomScale),
  } as CSSProperties;
  return { fontZoom, zoomStyle };
}
