import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { EmptyState, IconButton, T } from "@/ui";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { observeEditorFontZoom } from "../cm/prefs";
import { editorController, useTabErrors } from "../controller";
import type { EditorSlot } from "../model/slot";
import styles from "./EditorArea.module.css";

interface FontZoom {
  view: EditorView;
  size: number;
  offset: number;
}

function FontZoomIndicator({ zoom, dismiss }: { zoom: FontZoom; dismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [zoom, hovered, focused, dismiss]);

  return (
    <div
      className={styles.fontZoomIndicator}
      role="group"
      aria-label={tx("Editor font size")}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        zoom.view.focus();
        dismiss();
      }}
    >
      <span className={styles.fontZoomSize} role="status">
        {tx`Font size: ${zoom.size} px`}
      </span>
      <div className={styles.fontZoomActions}>
        <button
          type="button"
          className={styles.fontZoomReset}
          disabled={zoom.offset === 0}
          onClick={() => {
            zoom.view.focus();
            void executeAction("editor.resetFontSize");
          }}
        >
          <T>Reset Font Size</T>
        </button>
        <IconButton
          icon="settings"
          size="small"
          title="Open Editor Settings"
          action="file.settings"
          actionArg="editor.general"
          onClick={dismiss}
        />
      </div>
    </div>
  );
}

/** Mounts the CodeMirror view of one tab while it is visible. */
export function TextEditorHost({ tabId }: { tabId: string }) {
  const ctrl = editorController();
  const ref = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<EditorSlot | null>(() => ctrl.slotFor(tabId));
  const [zoom, setZoom] = useState<FontZoom | null>(null);
  const dismiss = useCallback(() => setZoom(null), []);
  const error = useTabErrors((s) => s[tabId]);

  useEffect(() => {
    if (slot && !slot.disposed) return;
    let live = true;
    void ctrl.ensureSlot(tabId).then((s) => {
      if (live && s) setSlot(s);
    });
    return () => {
      live = false;
    };
  }, [ctrl, tabId, slot]);

  useLayoutEffect(() => {
    if (!slot || slot.disposed || !ref.current) return;
    const view = slot.mount(ref.current);
    ctrl.onMounted(slot);
    const unsubscribe = observeEditorFontZoom(view, (offset) => {
      if (offset === null) return dismiss();
      const size = parseFloat(getComputedStyle(view.contentDOM).fontSize);
      if (Number.isFinite(size)) setZoom({ view, size, offset });
    });
    return () => {
      unsubscribe();
      slot.unmount();
    };
  }, [ctrl, slot, dismiss]);

  if (error)
    return (
      <div className={styles.host}>
        <EmptyState icon="warning" title="Cannot open file">
          {error}
        </EmptyState>
      </div>
    );
  return (
    <div className={styles.host}>
      <div ref={ref} className={styles.editorMount} data-editor-host="" aria-busy={!slot || undefined} />
      {zoom && zoom.view === slot?.view && <FontZoomIndicator zoom={zoom} dismiss={dismiss} />}
    </div>
  );
}
