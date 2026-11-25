/**
 * The Flutter Property Editor (Android Studio's, from DevTools): the arguments of the call at
 * the caret in a Dart file, as the Dart server's `dart/textDocument/editableArguments` lists
 * them, set with `dart/textDocument/editArgument`. The server applies its edit like any
 * `workspace/applyEdit`, so it is undone with the editor's Undo.
 */
import { EditorView } from "@codemirror/view";
import { create } from "zustand";
import { activeEditor, documentSynced, registerEditorContribution, useEditorRegistry } from "@/editor/api";
import type { ArgumentValue, EditableArgument, Pos } from "@/platform/ipc";

export interface PropertyEditorCaret {
  doc: number;
  pos: Pos;
  /** Resolves once the editor's edits reached the backend document the server reads. */
  synced: () => Promise<void>;
}

/** The caret of the active Dart editor; a new object on every move or edit. */
export const usePropertyEditorCaret = create<{
  caret: PropertyEditorCaret | null;
}>(() => ({ caret: null }));

const isDart = (h: ReturnType<typeof activeEditor>) => h?.ctx.language === "dart" && !h.ctx.virtual;

function syncCaret() {
  const h = activeEditor();
  if (!h || !isDart(h)) return usePropertyEditorCaret.setState({ caret: null });
  const head = h.view.state.selection.main.head;
  const line = h.view.state.doc.lineAt(head);
  const synced = h.view.state.facet(documentSynced) ?? (() => Promise.resolve());
  usePropertyEditorCaret.setState({
    caret: {
      doc: h.ctx.doc,
      pos: { line: line.number - 1, col: head - line.from },
      synced,
    },
  });
}

/** Follows the caret of Dart editors while the Property Editor is registered. */
export function trackPropertyEditorCaret(): () => void {
  const offContribution = registerEditorContribution({
    id: "flutter.propertyEditor",
    extensions: (ctx) =>
      ctx.language === "dart"
        ? EditorView.updateListener.of((u) => {
            if ((u.selectionSet || u.docChanged) && activeEditor()?.view === u.view) syncCaret();
          })
        : [],
  });
  const offRegistry = useEditorRegistry.subscribe((s, prev) => s.active !== prev.active && syncCaret());
  syncCaret();
  return () => {
    offContribution();
    offRegistry();
    usePropertyEditorCaret.setState({ caret: null });
  };
}

/** DevTools leaves out deprecated parameters the call doesn't pass. */
export const shownArguments = (args: readonly EditableArgument[]) =>
  args.filter((a) => !a.isDeprecated || a.hasArgument);

const enumType = (a: EditableArgument) => a.options?.[0]?.split(".")[0] ?? "enum";

/** The Dart type, as DevTools shows it: `String?`, `TextAlign`. */
export function typeLabel(a: EditableArgument): string {
  const t = a.type === "enum" ? enumType(a) : a.type === "string" ? "String" : a.type;
  return a.isNullable ? `${t}?` : t;
}

/** `TextAlign.center` as `.center`, like DevTools and the dot shorthand the server writes. */
const short = (a: EditableArgument, v: string) =>
  a.type === "enum" && v.startsWith(`${enumType(a)}.`) ? v.slice(enumType(a).length) : v;

/** What the call passes: the literal, else its expression; `null` for an explicit null, "" when not passed. */
export function shownValue(a: EditableArgument): string {
  if (a.displayValue != null) return short(a, a.displayValue);
  if (a.value != null) return short(a, String(a.value));
  return a.hasArgument ? "null" : "";
}

/** The default, shown while the call doesn't pass the argument. */
export const defaultText = (a: EditableArgument) => (a.defaultValue == null ? "" : short(a, String(a.defaultValue)));

/** The values a `bool` or enum argument picks from; `null` for the others, which are typed. */
export function choices(a: EditableArgument): string[] | null {
  if (a.type !== "bool" && a.type !== "enum") return null;
  const values = a.type === "bool" ? ["true", "false"] : (a.options ?? []).map((o) => short(a, o));
  const current = shownValue(a);
  if (current && current !== "null" && !values.includes(current)) values.push(current);
  if (a.isNullable) values.push("null");
  return values;
}

/** The value to send for the text the user entered; `undefined` when it isn't one of the type. */
export function parseInput(a: EditableArgument, input: string): { value: ArgumentValue | null } | undefined {
  const t = input.trim();
  if (a.isNullable && (t === "null" || (t === "" && a.type !== "string"))) return { value: null };
  switch (a.type) {
    case "string":
      return { value: input };
    case "int":
      return /^-?\d+$/.test(t) ? { value: Number(t) } : undefined;
    case "double":
      return t !== "" && Number.isFinite(Number(t)) ? { value: Number(t) } : undefined;
    case "bool":
      return t === "true" || t === "false" ? { value: t === "true" } : undefined;
    case "enum": {
      const value = t.startsWith(".") ? `${enumType(a)}${t}` : t;
      return a.options?.includes(value) ? { value } : undefined;
    }
  }
  return undefined;
}
