/**
 * SVG files as IDEA opens them: the source with the image viewer beside it (Editor Only / Editor and
 * Preview / Preview Only), the preview redrawn from the source as it's typed.
 */
import { useEffect, useRef, type ReactNode } from "react";
import clsx from "clsx";
import { editorsFor } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { FloatingToolbar, SplitGroup, SplitHandle, SplitPanel } from "@/ui";
import { imageInput } from "../fileKinds";
import { ImageViewer } from "../ImageViewer";
import { LayoutActions } from "../LayoutActions";
import { createLayoutModes, modeOf } from "../layoutModes";
import { useLiveSvg } from "./live";
import styles from "../markdown/Markdown.module.css";

export const svgModes = createLayoutModes("openidea.svg.defaultMode");

const SPLIT_STORAGE_KEY = "openidea.svg.split";
const DEFAULT_SPLIT_LAYOUT = { editor: 50, preview: 50 };

export function SvgLayoutActions({ tabId }: { path: string; tabId: string }) {
  const mode = svgModes.useModes((s) => modeOf(s, tabId));
  return <LayoutActions tabId={tabId} mode={mode} label={tx("SVG editor layout")} />;
}

function SvgPreview({ path }: { path: string }) {
  const source = useLiveSvg((s) => s[path]) ?? null;
  return <ImageViewer input={imageInput(path)} source={source} />;
}

export function SvgEditor({
  path,
  tabId,
  children,
  actionsInTabs = false,
}: {
  path: string;
  tabId: string;
  children: ReactNode;
  actionsInTabs?: boolean;
}) {
  const mode = svgModes.useModes((s) => modeOf(s, tabId));
  useEffect(() => svgModes.pin(tabId), [tabId]);
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // CodeMirror skips resizes right after a view update; re-measure on drags and mode changes.
  useEffect(() => {
    const el = editorRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (next === width) return;
      width = next;
      if (next <= 0) return;
      for (const ed of editorsFor(path)) {
        if (!ed.tabId || ed.tabId === tabId) ed.view.requestMeasure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [path, tabId]);

  const splitBounds = mode === "split" ? { minSize: "10%", maxSize: "90%" } : {};
  return (
    <div ref={ref} className={clsx(styles.split, styles[`mode-${mode}`])}>
      <SplitGroup
        orientation="horizontal"
        className={styles.group}
        storageKey={mode === "split" ? SPLIT_STORAGE_KEY : undefined}
        defaultLayout={mode === "split" ? DEFAULT_SPLIT_LAYOUT : undefined}
      >
        {/* Hidden but mounted in Preview Only, so the document stays open (see MarkdownEditor). */}
        <SplitPanel id="editor" style={{ overflow: "hidden" }} disabled={mode === "preview"} {...splitBounds}>
          <div ref={editorRef} className={styles.editor}>
            {children}
          </div>
        </SplitPanel>
        {mode === "split" && <SplitHandle aria-label={tx("Resize SVG preview")} />}
        {mode !== "editor" && (
          <SplitPanel id="preview" style={{ overflow: "hidden", display: "flex" }} {...splitBounds}>
            <SvgPreview path={path} />
          </SplitPanel>
        )}
      </SplitGroup>
      {!actionsInTabs && (
        <FloatingToolbar targetRef={ref}>
          <SvgLayoutActions path={path} tabId={tabId} />
        </FloatingToolbar>
      )}
    </div>
  );
}
