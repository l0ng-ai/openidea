/**
 * The documentation view with its history toolbar, as IDEA's one documentation
 * component: the F1 popup, the hover and the Documentation tool window show it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import clsx from "clsx";
import { useStore } from "zustand";
import { IconButton, Menu, selectableText } from "@/ui";
import { useTx } from "@/platform/i18n";
import { shortcutLabel, registerKeyClaim } from "@/platform/keymap";
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
import { DocFindBar } from "./DocFindBar";
import { activateDocMatch, clearDocSearch, highlightDocSearch, type DocSearchMatch } from "./docSearch";
import { renderMarkup } from "./markdown";
import styles from "./Popups.module.css";

export function DomContent({
  build,
  className,
  contentRef,
}: {
  build: () => HTMLElement;
  className?: string;
  contentRef?: RefObject<HTMLDivElement | null>;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = contentRef ?? ownRef;
  // Build the body before paint: the popup is measured as soon as it is created, so an empty first
  // frame would be placed and then moved once the text appeared.
  useLayoutEffect(() => {
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
  const tx = useTx();
  const moreButton = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<DocSearchMatch[] | null>(null);
  const activeMatchRef = useRef(-1);
  const [moreOpen, setMoreOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatch, setActiveMatch] = useState(-1);
  const pageKey = `${history.index}:${history.entries.length}`;
  const atStart = history.index === 0;
  const atEnd = history.index >= history.entries.length - 1;
  const focusFind = () => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  };
  const openFind = () => {
    setFindOpen(true);
    if (findOpen) focusFind();
    else requestAnimationFrame(focusFind);
  };
  const closeFind = () => {
    setFindOpen(false);
    setQuery("");
    frameRef.current?.focus({ preventScroll: true });
  };
  const goToMatch = (delta: -1 | 1) => {
    const matches = searchRef.current;
    if (!matches?.length) return;
    const next = (activeMatchRef.current + delta + matches.length) % matches.length;
    activeMatchRef.current = next;
    setActiveMatch(next);
    activateDocMatch(matches, next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (host === "window" && !e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      openFind();
      return;
    }
    if (findOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
      return;
    }
    if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable='true'], [data-doc-find]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      docStep(host, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "F4" && entry?.source) {
      e.preventDefault();
      void editDocSource(host);
    }
  };

  // The IDE keymap captures keys before React. Keep Documentation's Find shortcut and the open
  // bar's own keys (notably Escape) out of that dispatcher; popup and hover hosts claim nothing.
  useEffect(() => {
    if (host !== "window") return;
    return registerKeyClaim((e, stroke) => {
      if (!frameRef.current?.contains(e.target as Node)) return false;
      if (findOpen && (e.key === "Escape" || (e.target as Element | null)?.closest?.("[data-doc-find]"))) return true;
      return stroke === "Ctrl+F" || stroke === "Meta+F";
    });
  }, [host, findOpen]);

  useLayoutEffect(() => {
    if (findOpen) focusFind();
    // Reopening an already-open bar focuses and selects in the key handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen]);

  useLayoutEffect(() => {
    const body = contentRef.current;
    if (!findOpen || !query || !body) {
      activeMatchRef.current = -1;
      setMatchCount(0);
      setActiveMatch(-1);
      return;
    }
    let matches: DocSearchMatch[] = [];
    let disposed = false;
    const observer = new MutationObserver(() => apply(true, false));
    const apply = (keepActive: boolean, scroll: boolean) => {
      if (disposed) return;
      observer.disconnect();
      matches = highlightDocSearch(body, query);
      const active = matches.length
        ? keepActive
          ? Math.min(Math.max(activeMatchRef.current, 0), matches.length - 1)
          : 0
        : -1;
      activeMatchRef.current = active;
      searchRef.current = matches;
      setMatchCount(matches.length);
      setActiveMatch(active);
      if (active >= 0) activateDocMatch(matches, active, { scroll });
      observer.observe(body, { childList: true, characterData: true, subtree: true });
    };
    apply(false, true);
    // Markdown and code highlighting can finish after the first paint. Re-mark without moving the
    // viewport; only a new query or documentation page scrolls to its first active match.
    return () => {
      disposed = true;
      observer.disconnect();
      clearDocSearch(
        body,
        matches.flatMap((match) => match),
      );
      if (searchRef.current === matches) searchRef.current = null;
    };
  }, [findOpen, query, pageKey]);

  return (
    <div
      ref={frameRef}
      tabIndex={-1}
      data-lsp-doc={typeof host === "object" ? "hover" : host}
      className={clsx(themeClasses, host === "window" ? styles.docWindowFrame : styles.docFrame)}
      onKeyDown={onKeyDown}
    >
      {entry && (
        <DomContent
          key={pageKey}
          contentRef={contentRef}
          className={clsx(styles.docBody, selectableText)}
          build={() => {
            const dom = renderMarkup(entry.markup, entry.language, docLinkHandler(host));
            linkSignatureTypes(dom, host, entry);
            return dom;
          }}
        />
      )}
      {host === "window" && findOpen && (
        <DocFindBar
          query={query}
          onChange={setQuery}
          count={matchCount}
          active={activeMatch}
          inputRef={findInputRef}
          onNext={() => goToMatch(1)}
          onPrevious={() => goToMatch(-1)}
          onClose={closeFind}
        />
      )}
      <div className={styles.docToolbar}>
        {host !== "popup" && (
          <>
            <IconButton
              icon="arrow-left"
              size="small"
              title="Back"
              shortcut="←"
              disabled={atStart}
              onClick={() => docStep(host, -1)}
            />
            <IconButton
              icon="arrow-right"
              size="small"
              title="Forward"
              shortcut="→"
              disabled={atEnd}
              onClick={() => docStep(host, 1)}
            />
            <span className={styles.spacer} />
          </>
        )}
        {entry?.source && (
          <IconButton
            icon="edit"
            size="small"
            title="Edit Source"
            shortcut="F4"
            onClick={() => void editDocSource(host)}
          />
        )}
        {host === "window" && (
          <IconButton
            icon="search"
            size="small"
            title={tx("Find in Documentation")}
            shortcut={shortcutLabel("find.inFile") || undefined}
            onClick={openFind}
          />
        )}
        {host === "popup" ? (
          <>
            <IconButton
              ref={moreButton}
              icon="more-horizontal"
              size="small"
              title="More Actions"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            />
            <Menu
              open={moreOpen}
              onClose={() => setMoreOpen(false)}
              anchor={moreButton}
              placement="bottom-end"
              aria-label={tx("More Actions")}
              items={[
                {
                  label: "Show in Documentation Tool Window",
                  icon: "open-in-tool-window",
                  shortcut: shortcutLabel("code.quickDocumentation") || undefined,
                  run: () => moveDocPopupToWindow(host),
                },
                { kind: "separator" },
                {
                  label: "Back",
                  icon: "arrow-left",
                  shortcut: "←",
                  disabled: atStart,
                  run: () => docStep(host, -1),
                },
                {
                  label: "Forward",
                  icon: "arrow-right",
                  shortcut: "→",
                  disabled: atEnd,
                  run: () => docStep(host, 1),
                },
              ]}
            />
          </>
        ) : host !== "window" ? (
          <IconButton
            icon="open-in-tool-window"
            size="small"
            title="Show in Documentation Tool Window"
            onClick={() => moveDocPopupToWindow(host)}
          />
        ) : null}
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
  // Render before returning: CodeMirror measures the tooltip right after `create()`, so a popup
  // that is still empty at that point is placed a second time when the text arrives.
  flushSync(() => root.render(<HoverDocView doc={doc} />));
  return () => queueMicrotask(() => root.unmount());
}
