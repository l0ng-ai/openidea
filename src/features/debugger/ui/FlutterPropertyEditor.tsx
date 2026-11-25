/** The Flutter Property Editor tool window: the arguments of the call at the caret, editable. */
import { useEffect, useId, useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import { call, commands, type ArgumentValue, type EditableArgument, type EditableArguments } from "@/platform/ipc";
import { EmptyState, Input, Select } from "@/ui";
import {
  choices,
  defaultText,
  parseInput,
  shownArguments,
  shownValue,
  typeLabel,
  usePropertyEditorCaret,
  type PropertyEditorCaret,
} from "../flutter/propertyEditor";
import styles from "./FlutterPropertyEditor.module.css";

/** Caret moves settle before the server is asked (DevTools waits 600 ms). */
const DEBOUNCE_MS = 300;

type Shown =
  | { caret: PropertyEditorCaret; args: EditableArguments | null }
  | { caret: PropertyEditorCaret; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FlutterPropertyEditorView() {
  const tx = useTx();
  const caret = usePropertyEditorCaret((s) => s.caret);
  const [answer, setAnswer] = useState<Shown | null>(null);
  const shown = caret ? answer : null;
  const [failed, setFailed] = useState<{ name: string; error: string } | null>(null);
  useEffect(() => {
    if (!caret) return;
    let live = true;
    const timer = setTimeout(() => {
      caret
        .synced()
        .then(() => call(commands.lspEditableArguments(caret.doc, caret.pos)))
        .then(
          (args) => live && setAnswer({ caret, args }),
          (e: unknown) => live && setAnswer({ caret, error: message(e) }),
        );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [caret]);

  if (!shown) return <EmptyState title={tx("Open a Dart file to edit widget arguments")} />;
  if ("error" in shown) return <EmptyState title={tx("Couldn't get the widget's arguments")}>{shown.error}</EmptyState>;
  const { args } = shown;
  if (!args) return <EmptyState title={tx("Place the caret in a widget constructor call to edit its arguments")} />;
  const edit = (a: EditableArgument, value: ArgumentValue | null) => {
    setFailed(null);
    call(commands.lspEditArgument(shown.caret.doc, shown.caret.pos, a.name, value)).catch((e: unknown) =>
      setFailed({ name: a.name, error: message(e) }),
    );
  };
  const list = shownArguments(args.arguments);
  const summary = args.documentation?.split("\n\n")[0];
  return (
    <div className={styles.pane}>
      {args.name && <div className={styles.widget}>{args.name}</div>}
      {summary && <div className={styles.doc}>{summary}</div>}
      {list.length === 0 && <div className={styles.doc}>{tx("No editable arguments")}</div>}
      {list.map((a) => (
        <Row
          key={`${args.name}/${a.name}`}
          arg={a}
          error={failed?.name === a.name ? failed.error : undefined}
          onEdit={(v) => edit(a, v)}
        />
      ))}
    </div>
  );
}

function Row({
  arg,
  error,
  onEdit,
}: {
  arg: EditableArgument;
  error?: string;
  onEdit: (value: ArgumentValue | null) => void;
}) {
  const id = useId();
  const options = choices(arg);
  return (
    <div className={styles.row} title={arg.documentation ?? undefined}>
      <label htmlFor={id} className={styles.label}>
        <span className={clsx(styles.name, arg.isDeprecated && styles.deprecated)}>
          {arg.name}
          {arg.isRequired && "*"}
        </span>
        <span className={styles.type}>{typeLabel(arg)}</span>
      </label>
      {options ? (
        <Select
          id={id}
          value={shownValue(arg) || null}
          placeholder={defaultText(arg)}
          options={options.map((o) => ({ value: o, label: o, verbatim: true }))}
          disabled={!arg.isEditable}
          title={arg.notEditableReason ?? undefined}
          onChange={(v) => {
            const parsed = v === shownValue(arg) ? undefined : parseInput(arg, v);
            if (parsed) onEdit(parsed.value);
          }}
        />
      ) : (
        <TextField id={id} arg={arg} onEdit={onEdit} />
      )}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

/** Applied on Enter or leaving the field; Escape restores what the code passes. */
function TextField({
  id,
  arg,
  onEdit,
}: {
  id: string;
  arg: EditableArgument;
  onEdit: (value: ArgumentValue | null) => void;
}) {
  const shown = shownValue(arg);
  // A draft for what the code passed when typing began: an edit or caret move replaces it.
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft?.base === shown ? draft.text : shown;
  const setText = (t: string) => setDraft({ base: shown, text: t });
  const parsed = text === shown ? undefined : parseInput(arg, text);
  const commit = () => parsed && onEdit(parsed.value);
  return (
    <Input
      id={id}
      mono
      value={text}
      placeholder={defaultText(arg)}
      invalid={text !== shown && !parsed}
      disabled={!arg.isEditable}
      title={arg.notEditableReason ?? undefined}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(shown);
      }}
    />
  );
}
