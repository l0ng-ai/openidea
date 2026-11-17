/**
 * The documentation view with its history toolbar, as IDEA's one documentation
 * component: the F1 popup, the hover and the Documentation tool window show it.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import clsx from "clsx";
import { useStore } from "zustand";
import { IconButton, selectableText } from "@/ui";
import { shortcutLabel } from "@/platform/keymap";
import {
  docLinkHandler,
  docStep,
  editDocSource,
  linkSignatureTypes,
  moveDocPopupToWindow,
  type DocHistory,
  type DocHost,
  type HoverDoc,
} from "./docs";
import { renderMarkup } from "./markdown";
import styles from "./Popups.module.css";

export function DomContent({ build, className }: { build: () => HTMLElement; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const node = build();
    el.replaceChildren(node);
    return () => el.replaceChildren();
    // Built once per popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref} className={className} />;
}

export function DocView({ host, history, themeClasses }: { host: DocHost; history: DocHistory; themeClasses: string }) {
  const entry = history.entries[history.index];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      docStep(host, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "F4" && entry?.source) {
      e.preventDefault();
      void editDocSource(host);
    }
  };
  return (
    <div
      tabIndex={-1}
      data-lsp-doc={typeof host === "object" ? "hover" : host}
      className={clsx(themeClasses, host === "window" ? styles.docWindowFrame : styles.docFrame)}
      onKeyDown={onKeyDown}
    >
      {entry && (
        <DomContent
          key={`${history.index}:${history.entries.length}`}
          className={clsx(styles.docBody, selectableText)}
          build={() => {
            const dom = renderMarkup(entry.markup, entry.language, docLinkHandler(host));
            linkSignatureTypes(dom, host, entry);
            return dom;
          }}
        />
      )}
      <div className={styles.docToolbar}>
        <IconButton
          icon="arrow-left"
          size="small"
          title="Back"
          shortcut="←"
          disabled={history.index === 0}
          onClick={() => docStep(host, -1)}
        />
        <IconButton
          icon="arrow-right"
          size="small"
          title="Forward"
          shortcut="→"
          disabled={history.index >= history.entries.length - 1}
          onClick={() => docStep(host, 1)}
        />
        <span className={styles.spacer} />
        {entry?.source && (
          <IconButton
            icon="edit"
            size="small"
            title="Edit Source"
            shortcut="F4"
            onClick={() => void editDocSource(host)}
          />
        )}
        {host !== "window" && (
          <IconButton
            icon="open-in-tool-window"
            size="small"
            title="Show in Documentation Tool Window"
            shortcut={(host === "popup" && shortcutLabel("code.quickDocumentation")) || undefined}
            onClick={() => moveDocPopupToWindow(host)}
          />
        )}
      </div>
    </div>
  );
}

function HoverDocView({ doc }: { doc: HoverDoc }) {
  return <DocView host={doc} history={useStore(doc)} themeClasses="" />;
}

/** Mounts a hover's documentation into its CodeMirror tooltip; returns its unmount. */
export function mountHoverDoc(el: HTMLElement, doc: HoverDoc): () => void {
  const root = createRoot(el);
  root.render(<HoverDocView doc={doc} />);
  return () => queueMicrotask(() => root.unmount());
}
