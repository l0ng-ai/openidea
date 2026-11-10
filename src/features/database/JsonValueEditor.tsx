import { useEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { foldKeymap } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { baseExtensions, compartments } from "@/editor/core/cm/setup";
import { tx } from "@/platform/i18n";
import { Dialog, T, Button, type DialogButton } from "@/ui";
import { formatJson, jsonErrorOf, JSON_INLINE_LIMIT, type JsonError } from "./jsonValue";
import { registerValueEditorActions } from "./valueEditorActions";
import styles from "./Database.module.css";

export interface JsonEditorApi {
  reformat(): void;
  focus(): void;
}

const jsonLanguage = findLanguageDescription("JSON", "value.json");

/** A standalone value using the same editor setup and JSON support as file editors. */
export function JsonValueEditor(props: {
  initial: string;
  validate: boolean;
  emptyIsNull?: boolean;
  readOnly?: boolean;
  ariaLabel: string;
  onChange: (text: string, error: JsonError | null, pending: boolean) => void;
  onReady?: (api: JsonEditorApi | null) => void;
  onSubmit?: () => void;
  onOpenWindow?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let worker: Worker | null = null;
    const report = (text: string, error: JsonError | null, pending = false) => {
      current.current.onChange(text, current.current.validate ? error : null, pending && current.current.validate);
      queueMicrotask(() => {
        if (!alive || text !== view.state.doc.toString()) return;
        const from = Math.min(error?.pos ?? 0, Math.max(view.state.doc.length - 1, 0));
        view.dispatch(
          setDiagnostics(
            view.state,
            error
              ? [
                  {
                    from,
                    to: Math.min(from + 1, view.state.doc.length),
                    severity: current.current.validate ? "error" : "warning",
                    message: error.message,
                  },
                ]
              : [],
          ),
        );
      });
    };
    const analyze = (text: string, format = false) => {
      worker?.terminate();
      worker = null;
      if (text === "" && current.current.emptyIsNull) {
        report(text, null);
        return;
      }
      const done = (result: { text: string; error: JsonError | null }) => {
        if (!alive || text !== view.state.doc.toString()) return;
        if (format && result.text !== text && !current.current.readOnly)
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: result.text } });
        else report(text, result.error);
      };
      if (text.length <= JSON_INLINE_LIMIT) {
        done({ text: format ? formatJson(text) : text, error: jsonErrorOf(text) });
      } else {
        report(text, null, true);
        worker = new Worker(new URL("./jsonValue.worker.ts", import.meta.url), { type: "module" });
        const task = worker;
        worker.onmessage = (event: MessageEvent<{ text: string; error: JsonError | null }>) => {
          if (worker !== task) return;
          task.terminate();
          worker = null;
          done(event.data);
        };
        worker.onerror = () => {
          if (worker !== task) return;
          task.terminate();
          worker = null;
          report(text, { message: tx("JSON validation failed"), pos: 0 });
        };
        worker.postMessage({ text, format });
      }
    };
    const reformat = () => {
      if (!current.current.readOnly) analyze(view.state.doc.toString(), true);
      return true;
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.initial,
        extensions: baseExtensions({
          ctx: {
            doc: -1,
            path: "value.json",
            language: "json",
            uiMode: "JSON",
            readOnly: !!props.readOnly,
            virtual: true,
          },
          settings: undefined,
          info: undefined,
          language: null,
          docLength: props.initial.length,
          indent: { tabSize: 2, insertSpaces: true },
          wrapOverride: false,
          contributions: [],
          extra: [
            Prec.highest(
              keymap.of([
                {
                  key: "Mod-Enter",
                  run: () => {
                    current.current.onSubmit?.();
                    return true;
                  },
                },
                ...searchKeymap,
                ...foldKeymap,
              ]),
            ),
            EditorView.editable.of(!props.readOnly),
            Prec.highest(EditorView.contentAttributes.of({ "aria-label": props.ariaLabel, tabindex: "0" })),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) analyze(update.state.doc.toString());
            }),
          ],
        }),
      }),
    });
    if (jsonLanguage)
      void loadSupport(jsonLanguage).then((support) => {
        if (alive && support) view.dispatch({ effects: compartments.language.reconfigure(support) });
      });
    const unregisterActions = registerValueEditorActions(host, {
      reformat,
      find: () => {
        openSearchPanel(view);
      },
      openWindow: props.onOpenWindow ? () => current.current.onOpenWindow?.() : undefined,
      readOnly: !!props.readOnly,
    });
    analyze(props.initial);
    props.onReady?.({ reformat, focus: () => view.focus() });
    return () => {
      alive = false;
      unregisterActions();
      worker?.terminate();
      props.onReady?.(null);
      view.destroy();
    };
    // The parent re-keys the editor when its cell value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initial]);

  return <div ref={hostRef} className={styles.valueEditor} data-db-value-editor />;
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
  baseline?: string;
  validate: boolean;
  emptyIsNull?: boolean;
  readOnly?: boolean;
  onClose: () => void;
  /** Applies the editor's text (the caller's pending-edit pipeline); omit for read-only. */
  onApply?: (text: string) => void;
  onSetNull?: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const [error, setError] = useState<JsonError | null>(() =>
    !props.emptyIsNull && props.validate && props.initial.length <= JSON_INLINE_LIMIT
      ? jsonErrorOf(props.initial)
      : null,
  );
  const [pending, setPending] = useState(props.initial.length > JSON_INLINE_LIMIT);
  const editor = useRef<JsonEditorApi | null>(null);
  const [initialSize] = useState(
    () =>
      loadValueWindowSize() ?? {
        w: Math.min(760, globalThis.innerWidth - 64),
        h: Math.min(520, globalThis.innerHeight - 64),
      },
  );
  const dirty = text !== (props.baseline ?? props.initial);
  const apply = () => {
    if (!props.readOnly && dirty && !error && !pending) props.onApply?.(text);
  };
  const buttons: DialogButton[] = props.readOnly
    ? [{ label: "Close", role: "cancel", onClick: props.onClose }]
    : [
        ...(props.onSetNull ? [{ label: "Set NULL", onClick: props.onSetNull }] : []),
        { label: "Cancel", role: "cancel", onClick: props.onClose },
        { label: "Apply", role: "default", disabled: !dirty || !!error || pending, onClick: apply },
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
          <Button size="small" disabled={!!error || pending} onClick={() => editor.current?.reformat()}>
            <T>Reformat</T>
          </Button>
        )
      }
    >
      <div className={styles.valueWindowBody}>
        <JsonValueEditor
          initial={props.initial}
          validate={props.validate}
          emptyIsNull={props.emptyIsNull}
          readOnly={props.readOnly}
          ariaLabel={props.title}
          onChange={(t, e, busy) => {
            setText(t);
            setError(e);
            setPending(busy);
          }}
          onReady={(api) => {
            editor.current = api;
            api?.focus();
          }}
          onSubmit={() => {
            apply();
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
