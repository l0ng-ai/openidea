/**
 * The JSON value editor (#2333): the IDE's code editor (highlighting, bracket
 * matching, folding, find) in place of the Value panel's plain textarea, with
 * pretty-printing and live validation. Shared by the Value panel and the
 * "Open in Window" dialog (also ⇧Enter on a JSON cell of an editable grid).
 * Phase 1 covers JSON only; XML and bytea modes are follow-ups.
 */
import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { search, searchKeymap } from "@codemirror/search";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { openideaHighlightStyle } from "@/editor/core/cm/highlight";
import { openideaTheme } from "@/editor/core/cm/theme";
import { Dialog, T, Button, type DialogButton } from "@/ui";
import { formatJson, jsonErrorOf, type JsonError } from "./jsonValue";
import styles from "./Database.module.css";

/** What the parent may ask the mounted editor to do (Reformat, opening focus). */
export interface JsonEditorApi {
  reformat(): void;
  focus(): void;
}

const jsonLanguage = findLanguageDescription("JSON", "value.json");

const reformatDoc = (view: EditorView): boolean => {
  const doc = view.state.doc.toString();
  if (jsonErrorOf(doc)) return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatJson(doc) } });
  return true;
};

/** The IDE code editor over one JSON cell value. Mounts once per `initial`; the parent re-keys on another value. */
export function JsonValueEditor(props: {
  /** The text to open with, already pretty-printed by the caller. */
  initial: string;
  readOnly?: boolean;
  ariaLabel: string;
  /** Text and its syntax error after every change (drives Apply and the error line). */
  onChange: (text: string, error: JsonError | null) => void;
  /** The mounted editor's api (null once unmounted). */
  onReady?: (api: JsonEditorApi | null) => void;
  /** ⌘Enter inside the editor (the panel textarea's apply chord). */
  onSubmit?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Props read from the update listener and keymap stay current without rebuilding the view.
  const changeRef = useRef(props.onChange);
  changeRef.current = props.onChange;
  const submitRef = useRef(props.onSubmit);
  submitRef.current = props.onSubmit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          openideaTheme,
          syntaxHighlighting(openideaHighlightStyle),
          lineNumbers(),
          foldGutter(),
          bracketMatching(),
          indentOnInput(),
          closeBrackets(),
          history(),
          search({ top: true }),
          keymap.of([
            { key: "Mod-Alt-l", run: (v) => reformatDoc(v) },
            {
              key: "Mod-Enter",
              run: () => {
                if (!submitRef.current) return false;
                submitRef.current();
                return true;
              },
            },
          ]),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          language.of([]),
          props.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : ([] as Extension),
          EditorView.lineWrapping,
          linter(
            (v) => {
              const error = jsonErrorOf(v.state.doc.toString());
              if (!error) return [];
              // Mark the offending character; a position at the end marks the last one.
              const from = Math.min(error.pos, Math.max(v.state.doc.length - 1, 0));
              const diagnostic: Diagnostic = {
                from,
                to: Math.min(from + 1, v.state.doc.length),
                severity: "error",
                message: error.message,
              };
              return [diagnostic];
            },
            { delay: 150 },
          ),
          EditorView.contentAttributes.of({ "aria-label": props.ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const doc = update.state.doc.toString();
              changeRef.current(doc, jsonErrorOf(doc));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    let alive = true;
    if (jsonLanguage)
      void loadSupport(jsonLanguage).then((support) => {
        if (alive && support && viewRef.current) viewRef.current!.dispatch({ effects: language.reconfigure(support) });
      });
    props.onReady?.({
      reformat: () => void reformatDoc(view),
      focus: () => view.focus(),
    });
    return () => {
      alive = false;
      props.onReady?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // The editor belongs to one cell value; the parent re-keys on another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initial]);

  return <div ref={hostRef} className={styles.valueEditor} />;
}

const VALUE_WINDOW_SIZE_KEY = "openidea.database.valueWindowSize";

/** The value window's last size; null on first run, clamped to the window by Dialog. */
export function loadValueWindowSize(): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(VALUE_WINDOW_SIZE_KEY) ?? "null") as { w?: unknown; h?: unknown } | null;
    return typeof v?.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : null;
  } catch {
    return null;
  }
}

export function saveValueWindowSize(size: { w: number; h: number }) {
  try {
    localStorage.setItem(VALUE_WINDOW_SIZE_KEY, JSON.stringify(size));
  } catch {
    // Private mode etc. — the size just isn't remembered.
  }
}

/** The value editor in a resizable window whose size is remembered between openings. */
export function JsonValueWindow(props: {
  title: string;
  /** The text to open with, already pretty-printed by the caller. */
  initial: string;
  readOnly?: boolean;
  onClose: () => void;
  /** Applies the editor's text (the caller's pending-edit pipeline); omit for read-only. */
  onApply?: (text: string) => void;
  onSetNull?: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const [error, setError] = useState<JsonError | null>(null);
  const editor = useRef<JsonEditorApi | null>(null);
  const [initialSize] = useState(
    () =>
      loadValueWindowSize() ?? {
        w: Math.min(760, globalThis.innerWidth - 64),
        h: Math.min(520, globalThis.innerHeight - 64),
      },
  );
  const dirty = text !== props.initial;
  const apply = () => props.onApply?.(text);
  const buttons: DialogButton[] = props.readOnly
    ? [{ label: "Close", role: "cancel", onClick: props.onClose }]
    : [
        ...(props.onSetNull ? [{ label: "Set NULL", onClick: props.onSetNull }] : []),
        { label: "Cancel", role: "cancel", onClick: props.onClose },
        { label: "Apply", role: "default", disabled: !dirty || !!error, onClick: apply },
      ];
  return (
    <Dialog
      open
      title={props.title}
      onClose={props.onClose}
      buttons={buttons}
      width={760}
      minWidth={420}
      minHeight={280}
      resizable="both"
      initialSize={initialSize}
      onResized={saveValueWindowSize}
      footerStart={
        props.readOnly ? undefined : (
          <Button size="small" disabled={!!error} onClick={() => editor.current?.reformat()}>
            <T>Reformat</T>
          </Button>
        )
      }
    >
      <div className={styles.valueWindowBody}>
        <JsonValueEditor
          initial={props.initial}
          readOnly={props.readOnly}
          ariaLabel={props.title}
          onChange={(t, e) => {
            setText(t);
            setError(e);
          }}
          onReady={(api) => (editor.current = api)}
          onSubmit={() => {
            if (dirty && !error) apply();
          }}
        />
        {error && (
          <div className={styles.valueError} role="status">
            {error.message}
          </div>
        )}
      </div>
    </Dialog>
  );
}
