/** Inline change popup shown when clicking a gutter change marker. */
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton, Popup } from "@/ui";
import { editorHunks, gotoChange, setHunkPopupHooks, type EditorHunk } from "./gutter";
import styles from "./HunkPopup.module.css";
import { tx } from "@/platform/i18n";

interface PopupState {
  view: EditorView;
  hunk: EditorHunk;
  path: string;
  x: number;
  y: number;
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
  const endPos = hunk.to > hunk.from ? Math.max(hunk.from, hunk.to - 1) : Math.min(hunk.from, doc.length);
  const coords = view.coordsAtPos(doc.lineAt(endPos).from);
  const gutterRect = view.dom.querySelector(".cm-openidea-lane")?.getBoundingClientRect();
  const x = gutterRect ? gutterRect.right : (coords?.left ?? 0);
  const y = coords ? (hunk.to > hunk.from ? coords.bottom : coords.top) : 0;
  openFor = view;
  render({ view, hunk, path, x, y, id: ++seq });
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

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const KIND_TITLE = { added: "Added lines", modified: "Modified lines", deleted: "Deleted lines" } as const;

function HunkPopupView({ state }: { state: PopupState }) {
  const { view, hunk, path } = state;
  const [copied, setCopied] = useState(false);
  const current = view.state.sliceDoc(hunk.from, hunk.to);
  const oldLines = splitLines(hunk.oldText);
  const newLines = splitLines(current);
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
    const target = gotoChange(view, dir);
    if (target) requestAnimationFrame(() => openHunkPopup(view, target, path));
    else closeHunkPopup();
  };

  return (
    <Popup
      open
      anchor={{ x: state.x, y: state.y }}
      placement="bottom-start"
      offset={2}
      onClose={closeHunkPopup}
      aria-label={KIND_TITLE[hunk.kind]}
      className={styles.popup}
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
            void navigator.clipboard?.writeText(hunk.oldText).then(() => setCopied(true));
          }}
        />
        <span className={styles.title}>
          {tx(KIND_TITLE[hunk.kind])}
          {index >= 0 && all.length > 1 && <span className={styles.counter}>{tx`${index + 1} of ${all.length}`}</span>}
        </span>
        <IconButton icon="close" title="Close" size="small" onClick={closeHunkPopup} />
      </div>
      {(oldLines.length > 0 || newLines.length > 0) && (
        <div className={styles.body}>
          {oldLines.map((l, i) => (
            <div key={`o${i}`} className={styles.removed}>
              <span className={styles.sign} aria-hidden>
                -
              </span>
              {l || " "}
            </div>
          ))}
          {newLines.map((l, i) => (
            <div key={`n${i}`} className={styles.added}>
              <span className={styles.sign} aria-hidden>
                +
              </span>
              {l || " "}
            </div>
          ))}
        </div>
      )}
    </Popup>
  );
}
