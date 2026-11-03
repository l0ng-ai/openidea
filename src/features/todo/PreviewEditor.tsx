/**
 * Editable preview for the TODO tool window: a CodeMirror view attached to the
 * real document (attachDocument), so edits share the buffer with the editor
 * tabs and are saved by Save All. Opt-in via the "Allow editing" checkbox.
 *
 * Dirty buffers are never released: releasing a document nobody else shows
 * would either auto-save it or close it and drop the edits. Instead they are
 * held here (an invisible open document — Save All still reaches them), and
 * `previewText` reads them so the read-only preview shows the edited text.
 */
import { useEffect, useRef, useState } from "react";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { syntaxHighlighting } from "@codemirror/language";
import { openideaTheme } from "@/editor/core/cm/theme";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { attachDocument, embeddedEditorExtensions, type DocumentAttachment } from "@/editor/api";
import { T } from "@/ui";
import { tx } from "@/platform/i18n";
import styles from "./TodoView.module.css";

/** Dirty attachments kept alive after their view unmounted (see header note). */
const heldDirty = new Map<string, DocumentAttachment>();

/** The held attachment for `path`, if it is still dirty; releases it otherwise. */
export function heldAttachment(path: string): DocumentAttachment | null {
  const att = heldDirty.get(path) ?? null;
  if (att && !att.dirty()) {
    heldDirty.delete(path);
    att.release();
    return null;
  }
  return att;
}

/**
 * The editable pane for one TODO item's file. Mounts a CodeMirror view over
 * the attached document and centres the item's line. Remounts per `path`;
 * switching files unmounts (holding or releasing the previous attachment,
 * see the cleanup below).
 */
export function PreviewEditor({ path, line, col }: { path: string; line: number; col: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let view: EditorView | null = null;
    let att: DocumentAttachment | null = null;
    void (async () => {
      try {
        att = await attachDocument(path);
        if (!alive) return void att.release();
        if (att.readOnly) {
          // Read-only files (disk flag, virtual docs) cannot be edited here.
          att.release();
          if (alive) setError(tx("This file cannot be edited"));
          return;
        }
        const language = new Compartment();
        view = new EditorView({
          state: EditorState.create({
            doc: att.text(),
            extensions: [
              openideaTheme,
              syntaxHighlighting(openideaHighlightStyle),
              lineNumbers(),
              highlightActiveLine(),
              history(),
              search({ top: true }),
              // Mod-S is intentionally not bound: the global keymap's
              // `file.save` (Save All) runs on capture before CodeMirror and
              // saves the attached document together with the rest — same as
              // the diff viewer's editable side.
              keymap.of([...historyKeymap, ...searchKeymap, ...defaultKeymap]),
              att.extension,
              embeddedEditorExtensions(path),
              language.of([]),
            ],
          }),
          parent: hostRef.current!,
        });
        // Centre the TODO item; the view starts at its line.
        const at = Math.min(view.state.doc.lines, line + 1);
        const text = view.state.doc.line(at);
        const pos = Math.min(text.from + col, text.to);
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
        // Language loads async, like the notebook cells. The mode comes from the
        // document (backend-assigned): filename guessing inside
        // findLanguageDescription is disabled once the backend language table
        // has loaded, so passing null would leave the view uncoloured.
        const desc = findLanguageDescription(att.uiMode(), path);
        if (desc)
          void loadSupport(desc).then((support) => {
            if (alive && support && view) view.dispatch({ effects: language.reconfigure(support) });
          });
      } catch (e) {
        // Editor core not started (tests) or the document failed to open.
        if (alive) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => {
      alive = false;
      view?.destroy();
      // Hold dirty buffers (see header); release clean ones.
      if (att) {
        if (att.dirty()) heldDirty.set(path, att);
        else att.release();
      }
    };
    // `line`/`col` only place the initial caret; the view itself is per path.
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <div className={styles.previewError}>
        <T>{error}</T>
      </div>
    );
  return <div ref={hostRef} className={styles.previewEditor} />;
}
