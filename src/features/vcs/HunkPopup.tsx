/** Inline change popup shown when clicking a gutter change marker. */
import { writeClipboardText } from "@/platform/clipboard";
import { useEffect, useState, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { previewColors, tokenSpans, type CodeToken } from "@/editor/lineTokens";
import { IconButton, Popup, selectableText } from "@/ui";
import type { PopupAnchor } from "@/ui/Popup";
import { editorHunks, gotoChange, setHunkPopupHooks, type EditorHunk } from "./gutter";
import styles from "./HunkPopup.module.css";
import { tx } from "@/platform/i18n";

interface PopupState {
  view: EditorView;
  hunk: EditorHunk;
  path: string;
  anchor: PopupAnchor;
  width: number;
  id: number;
}

let root: Root | null = null;
let openFor: EditorView | null = null;
let host: HTMLElement | null = null;
let seq = 0;

function render(state: PopupState | null) {
  if (!state && !root) return;
  if (!root) {
    host = document.createElement("div");
    host.dataset.vcsHunkPopup = "";
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root.render(state ? <HunkPopupView key={state.id} state={state} /> : null);
}

export function closeHunkPopup() {
  openFor = null;
  render(null);
}

export function openHunkPopup(view: EditorView, hunk: EditorHunk, path: string) {
  const doc = view.state.doc;
  const from = Math.min(hunk.from, doc.length);
  const to = Math.min(Math.max(from, hunk.to - 1), doc.length);
  const anchor = {
    contextElement: view.scrollDOM,
    getBoundingClientRect: () => {
      const start = view.coordsAtPos(from);
      const visible = view.scrollDOM.getBoundingClientRect();
      const gutter = view.dom.querySelector(".cm-openidea-lane")?.getBoundingClientRect();
      const x = Math.max(start?.left ?? visible.left, gutter?.right ?? visible.left);
      const top = view.documentTop + view.lineBlockAt(from).top;
      const bottom = hunk.to > hunk.from ? view.documentTop + view.lineBlockAt(to).bottom : top;
      const clampY = (y: number) => Math.min(visible.bottom, Math.max(visible.top, y));
      // Flipping above the change leaves the current lines in the editor visible.
      return new DOMRect(x, clampY(top), 0, Math.max(0, clampY(bottom) - clampY(top)));
    },
  };
  const width = Math.max(240, view.scrollDOM.getBoundingClientRect().right - anchor.getBoundingClientRect().left);
  openFor = view;
  render({ view, hunk, path, anchor, width, id: ++seq });
}

export function installHunkPopup(): () => void {
  setHunkPopupHooks({
    open: openHunkPopup,
    docChanged: (view) => {
      if (openFor === view) closeHunkPopup();
    },
  });
  return () => {
    setHunkPopupHooks(null);
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
  };
}

const KIND_TITLE = { added: "Added lines", modified: "Modified lines", deleted: "Deleted lines" } as const;

function OriginalText({ view, path, text }: { view: EditorView; path: string; text: string }) {
  const [tokens, setTokens] = useState<CodeToken[] | null>(null);
  const [font] = useState(() => {
    const { fontFamily, fontSize, fontWeight, lineHeight, fontVariantLigatures } = getComputedStyle(view.contentDOM);
    return { fontFamily, fontSize, fontWeight, lineHeight, fontVariantLigatures, tabSize: view.state.tabSize };
  });
  useEffect(() => {
    if (text.length > 100_000) return;
    let alive = true;
    void previewColors(text, path).then((colorize) => {
      if (alive && colorize) setTokens(colorize(0, text.length));
    });
    return () => {
      alive = false;
    };
  }, [text, path]);
  return (
    <pre
      role="region"
      aria-label={tx("Original text")}
      tabIndex={0}
      className={`${styles.preview} ${selectableText}`}
      style={font}
    >
      {tokenSpans(text, 0, text.length, tokens)}
    </pre>
  );
}

function HunkPopupView({ state }: { state: PopupState }) {
  const { view, hunk, path } = state;
  const [copied, setCopied] = useState(false);
  const all = editorHunks(view.state);
  const index = all.findIndex((h) => h.start === hunk.start && h.oldStart === hunk.oldStart);

  const rollback = () => {
    const live = editorHunks(view.state).find((h) => h.start === hunk.start && h.oldStart === hunk.oldStart) ?? hunk;
    view.dispatch({
      changes: { from: live.from, to: live.to, insert: live.oldText },
      userEvent: "input.rollback",
      scrollIntoView: true,
    });
    closeHunkPopup();
    view.focus();
  };

  const step = (dir: 1 | -1) => {
    const target = gotoChange(view, dir, hunk.from);
    if (target) requestAnimationFrame(() => openHunkPopup(view, target, path));
    else closeHunkPopup();
  };

  return (
    <Popup
      open
      anchor={state.anchor}
      placement="bottom-start"
      offset={2}
      onClose={closeHunkPopup}
      aria-label={tx(KIND_TITLE[hunk.kind])}
      className={styles.popup}
      style={{ "--hunk-popup-width": `${state.width}px` } as CSSProperties}
      unstyled
    >
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Change actions")}>
        <IconButton
          icon="arrow-up"
          title="Previous Change"
          shortcut={shortcutLabel("vcs.prevChange")}
          size="small"
          onClick={() => step(-1)}
        />
        <IconButton
          icon="arrow-down"
          title="Next Change"
          shortcut={shortcutLabel("vcs.nextChange")}
          size="small"
          onClick={() => step(1)}
        />
        <IconButton icon="undo" title="Rollback" size="small" data-autofocus onClick={rollback} />
        <IconButton
          icon="diff"
          title="Show Diff"
          size="small"
          onClick={() => {
            closeHunkPopup();
            void executeAction("vcs.showDiff", { path, line: hunk.start });
          }}
        />
        <IconButton
          icon={copied ? "check" : "copy"}
          title="Copy Original Text"
          size="small"
          disabled={!hunk.oldText}
          onClick={() => {
            void writeClipboardText(hunk.oldText).then(() => setCopied(true));
          }}
        />
        <span className={styles.title}>
          {tx(KIND_TITLE[hunk.kind])}
          {index >= 0 && all.length > 1 && <span className={styles.counter}>{tx`${index + 1} of ${all.length}`}</span>}
        </span>
        <IconButton icon="close" title="Close" size="small" onClick={closeHunkPopup} />
      </div>
      {hunk.oldText && <OriginalText view={view} path={path} text={hunk.oldText} />}
    </Popup>
  );
}
