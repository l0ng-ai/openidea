import { useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorSelection, EditorState, Prec, StateEffect } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  tooltips,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import type { NotebookCellDoc } from "@/bindings";
import { cellEditorExtensions } from "@/editor/api";
import { openideaTheme } from "@/editor/core/cm/theme";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { selectionMarks } from "@/editor/core/cm/selectionMarks";
import { seamlessSelection } from "@/editor/core/cm/selectionLayer";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { tooltipBounds } from "@/editor/core/cm/setup";
import { tx } from "@/platform/i18n";
import type { CellReveal, NotebookSession } from "./session";
import styles from "./Notebook.module.css";

const external = Annotation.define<boolean>();

/** Completion, hover, diagnostics and navigation for a code cell its language servers know. */
function languageServices(type: string, doc: NotebookCellDoc | undefined) {
  if (type !== "code" || !doc) return [];
  return cellEditorExtensions({ doc: doc.doc, path: doc.uri, language: "python", uiMode: "Python", readOnly: false });
}

export function CellEditor({
  session,
  id,
  source,
  type,
  frozen,
  doc,
  reveal,
}: {
  session: NotebookSession;
  id: string;
  source: string;
  type: string;
  frozen: boolean;
  doc?: NotebookCellDoc;
  /** A location to show in this cell. */
  reveal?: CellReveal | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const readonly = useRef(new Compartment());
  const services = useRef(new Compartment());
  const initialSource = useRef(source);
  const initialDoc = useRef(doc);
  useLayoutEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const configuration = [
      // Completion and hover popups leave the cell, whose border clips its content.
      tooltips({ parent: document.body, tooltipSpace: tooltipBounds }),
      openideaTheme,
      syntaxHighlighting(openideaHighlightStyle),
      lineNumbers(),
      drawSelection(),
      selectionMarks,
      seamlessSelection(),
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
      services.current.of(languageServices(type, initialDoc.current)),
      readonly.current.of(EditorState.readOnly.of(session.getState().frozen)),
      EditorView.lineWrapping,
      EditorView.theme({ "&.cm-editor": { height: "auto" }, ".cm-scroller": { maxHeight: "640px", overflow: "auto" } }),
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
  const docId = doc?.doc;
  const docUri = doc?.uri;
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    initialDoc.current = doc;
    editor.dispatch({ effects: services.current.reconfigure(languageServices(type, doc)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a refetch gives the same document a new object
  }, [docId, docUri, type]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || !reveal || reveal.cell !== id || session.revealed >= reveal.seq) return;
    session.revealed = reveal.seq;
    if (reveal.selection) {
      const text = editor.state.doc;
      const line = text.line(Math.min(reveal.selection.line + 1, text.lines));
      const at = line.from + Math.min(reveal.selection.col, line.length);
      editor.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
    }
    editor.focus();
  }, [reveal, id, session]);
  return <div ref={host} className={styles.cellEditor} />;
}

// No CodeMirror history extension: source and structural undo share backend history.
