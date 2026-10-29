import { useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec, StateEffect } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { openideaTheme } from "@/editor/core/cm/theme";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { tx } from "@/platform/i18n";
import type { NotebookSession } from "./session";
import styles from "./Notebook.module.css";

const external = Annotation.define<boolean>();
export function CellEditor({
  session,
  id,
  source,
  type,
  frozen,
}: {
  session: NotebookSession;
  id: string;
  source: string;
  type: string;
  frozen: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readonly = useRef(new Compartment());
  const initialSource = useRef(source);
  useLayoutEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const configuration = [
      openideaTheme,
      syntaxHighlighting(openideaHighlightStyle),
      lineNumbers(),
      drawSelection(),
      highlightActiveLine(),
      highlightSpecialChars(),
      bracketMatching(),
      indentOnInput(),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-z",
            run: () => {
              void session.undo().catch((e) => session.report(e));
              return true;
            },
          },
          {
            key: "Mod-Shift-z",
            run: () => {
              void session.redo().catch((e) => session.report(e));
              return true;
            },
          },
          {
            key: "Mod-y",
            run: () => {
              void session.redo().catch((e) => session.report(e));
              return true;
            },
          },
        ]),
      ),
      keymap.of([indentWithTab, ...defaultKeymap]),
      language.of([]),
      readonly.current.of(EditorState.readOnly.of(session.getState().frozen)),
      EditorView.lineWrapping,
      EditorView.theme({ "&": { height: "auto" }, ".cm-scroller": { maxHeight: "640px", overflow: "auto" } }),
      EditorView.contentAttributes.of({
        "aria-label": tx(type === "code" ? "Python cell source" : "Markdown cell source"),
      }),
      EditorState.transactionFilter.of((transaction) =>
        transaction.docChanged && session.getState().frozen && !transaction.annotation(external) ? [] : transaction,
      ),
      EditorView.updateListener.of((update) => {
        session.editors.set(id, update.state);
        if (update.docChanged && update.transactions.some((tr) => !tr.annotation(external))) {
          session.edit({ type: "setSource", cell: id, source: update.state.doc.toString() });
        }
      }),
    ];
    // Reconfigure saved state to replace stale view closures; retain selection.
    const saved = session.editors.get(id);
    const state = saved
      ? saved.update({ effects: StateEffect.reconfigure.of(configuration) }).state
      : EditorState.create({ doc: initialSource.current, extensions: configuration });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    let alive = true;
    const description = findLanguageDescription(
      type === "code" ? "Python" : "Markdown",
      type === "code" ? "cell.py" : "cell.md",
    );
    if (description)
      void loadSupport(description).then((support) => {
        if (alive && support) editor.dispatch({ effects: language.reconfigure(support) });
      });
    return () => {
      alive = false;
      session.editors.set(id, editor.state);
      view.current = null;
      editor.destroy();
    };
  }, [session, id, type]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (editor.state.doc.toString() !== source)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: source },
        annotations: external.of(true),
      });
    editor.dispatch({ effects: readonly.current.reconfigure(EditorState.readOnly.of(frozen)) });
  }, [source, frozen]);
  return <div ref={host} className={styles.cellEditor} />;
}

// No CodeMirror history extension: source and structural undo share backend history.
