/**
 * Generate (⌘N) in a Python class: an `__init__` assigning the chosen class fields, and
 * properties (getter and setter) for the chosen attributes, besides Override / Implement Methods.
 */
import type { EditorView } from "@codemirror/view";
import { showHint } from "../../hint";
import { chooseMembers } from "../../memberChooser";
import type { GenerateEntry } from "../languages";
import {
  bodyEnd,
  classMembers,
  enclosingClass,
  implementPythonAbstractMethods,
  indentOf,
  insertMembers,
  isPython,
  overridePythonMethods,
  signatureParams,
} from "./members";

export interface PythonField {
  name: string;
  annotation: string | null;
  /** Default value text (a class field's value). */
  value: string | null;
}

const FIELD = /^(\w+)\s*(?::\s*([^=]+?))?\s*(?:=(?!=)\s*(.+?))?\s*(?:#.*)?$/;
const SELF_ATTR = /^\s*self\.(\w+)\s*(?::\s*([^=]+?))?\s*=(?!=)/;

/** Body lines of the class headed at `header` (1-based) outside triple-quoted strings, with their numbers. */
function codeLines(lines: readonly string[], header: number): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let quote: string | null = null;
  for (let n = header + 1; n <= bodyEnd(lines, header); n++) {
    const text = lines[n - 1]!;
    const inString = quote !== null;
    for (const q of text.match(/"""|'''/g) ?? []) {
      if (quote === null) quote = q;
      else if (q === quote) quote = null;
    }
    if (!inString && text.trim()) out.push({ n, text });
  }
  return out;
}

/** Fields declared in the body of the class headed at `header` (`x: int`, `x: int = 0`, `x = 0`). */
export function classFields(lines: readonly string[], header: number): PythonField[] {
  const body = codeLines(lines, header);
  const indent = body[0] ? indentOf(body[0].text) : -1;
  const out: PythonField[] = [];
  for (const { text } of body) {
    if (indentOf(text) !== indent) continue;
    const m = FIELD.exec(text.trim());
    if (!m || (!m[2] && !m[3]) || m[1]!.startsWith("__")) continue;
    if (m[2] && /^(typing\.)?ClassVar\b/.test(m[2])) continue;
    out.push({ name: m[1]!, annotation: m[2]?.trim() ?? null, value: m[3]?.trim() ?? null });
  }
  return out;
}

/**
 * Attributes assigned on `self` in the methods of the class headed at `header`, in order, with
 * the annotation written there or on the `__init__` parameter they are assigned from.
 */
export function instanceAttributes(lines: readonly string[], header: number): PythonField[] {
  const init = classMembers(lines, header).find((m) => m.name === "__init__");
  const params = new Map<string, string>();
  for (const p of (init && signatureParams(init.lines.filter((l) => !l.startsWith("@")).join(" "))) ?? []) {
    const m = /^(\w+)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(p);
    if (m) params.set(m[1]!, m[2]!);
  }
  const out = new Map<string, PythonField>();
  for (const { text } of codeLines(lines, header)) {
    const m = SELF_ATTR.exec(text);
    if (!m) continue;
    const source = /=\s*(\w+)\s*(?:#.*)?$/.exec(text)?.[1];
    const annotation = m[2]?.trim() ?? (source ? params.get(source) : undefined) ?? null;
    const known = out.get(m[1]!);
    if (!known) out.set(m[1]!, { name: m[1]!, annotation, value: null });
    else if (!known.annotation) known.annotation = annotation;
  }
  return [...out.values()];
}

/** An `__init__` taking `fields` (those with a value last, keeping it as the default) and assigning them. */
export function initText(fields: readonly PythonField[], indent: string, unit: string): string {
  const ordered = [...fields.filter((f) => f.value === null), ...fields.filter((f) => f.value !== null)];
  const params = ordered.map(
    (f) =>
      f.name +
      (f.annotation ? `: ${f.annotation}` : "") +
      (f.value === null ? "" : f.annotation ? ` = ${f.value}` : `=${f.value}`),
  );
  return [
    `${indent}def __init__(${["self", ...params].join(", ")}):`,
    ...(fields.length ? fields.map((f) => `${indent}${unit}self.${f.name} = ${f.name}`) : [`${indent}${unit}pass`]),
  ].join("\n");
}

/** The property for `attr`: a getter returning `self._name` and its setter. */
export function propertyText(attr: PythonField, indent: string, unit: string): string {
  const name = attr.name.replace(/^_+/, "") || attr.name;
  const field = `_${name}`;
  const type = attr.annotation;
  return [
    `${indent}@property`,
    `${indent}def ${name}(self)${type ? ` -> ${type}` : ""}:`,
    `${indent}${unit}return self.${field}`,
    "",
    `${indent}@${name}.setter`,
    `${indent}def ${name}(self, value${type ? `: ${type}` : ""})${type ? " -> None" : ""}:`,
    `${indent}${unit}self.${field} = value`,
  ].join("\n");
}

function classAtCaret(view: EditorView): { lines: string[]; header: number } | null {
  const lines = view.state.doc.toJSON();
  const header = enclosingClass(lines, view.state.doc.lineAt(view.state.selection.main.head).number, true);
  return header ? { lines, header } : null;
}

/** Generate › Constructor: `__init__` for the class fields chosen in a dialog. */
export async function generatePythonInit(view: EditorView): Promise<void> {
  const cls = classAtCaret(view);
  if (!cls) return;
  const { lines, header } = cls;
  if (classMembers(lines, header).some((m) => m.name === "__init__")) {
    showHint(view, "The class already defines __init__");
    return;
  }
  const fields = classFields(lines, header);
  const insert = (chosen: readonly PythonField[]) =>
    insertMembers(view, lines, header, (indent, unit) => initText(chosen, indent, unit), [], true);
  if (!fields.length) {
    insert([]);
    return;
  }
  const ids = await chooseMembers(view, {
    title: "Choose Fields to Initialize by Constructor",
    members: fields.map((f, i) => ({
      id: String(i),
      label: f.name,
      detail: (f.annotation ? `: ${f.annotation}` : "") + (f.value ? ` = ${f.value}` : ""),
      icon: "field",
    })),
  });
  if (!ids || view.state.doc.toJSON().join("\n") !== lines.join("\n")) return;
  insert(ids.map((id) => fields[Number(id)]!));
}

/** Generate › Property: a getter and setter for each attribute chosen in a dialog. */
export async function generatePythonProperties(view: EditorView): Promise<void> {
  const cls = classAtCaret(view);
  if (!cls) return;
  const { lines, header } = cls;
  const taken = new Set(classMembers(lines, header).map((m) => m.name));
  const attrs = instanceAttributes(lines, header).filter((a) => !taken.has(a.name.replace(/^_+/, "") || a.name));
  if (!attrs.length) {
    showHint(view, "No attributes to generate properties for");
    return;
  }
  const ids = await chooseMembers(view, {
    title: "Choose Attributes to Generate Properties For",
    members: attrs.map((a, i) => ({
      id: String(i),
      label: a.name,
      detail: a.annotation ? `: ${a.annotation}` : undefined,
      icon: "field",
    })),
  });
  if (!ids?.length || view.state.doc.toJSON().join("\n") !== lines.join("\n")) return;
  const chosen = ids.map((id) => attrs[Number(id)]!);
  insertMembers(view, lines, header, (indent, unit) => chosen.map((a) => propertyText(a, indent, unit)).join("\n\n"));
}

/** Generate (⌘N) in a Python class: `__init__`, properties, Override / Implement Methods. */
export function pythonGenerateEntries(view: EditorView): GenerateEntry[] {
  if (!isPython(view)) return [];
  const lines = view.state.doc.toJSON();
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  if (!enclosingClass(lines, line, true)) return [];
  const entries: GenerateEntry[] = [
    {
      id: "python.generateInit",
      label: "Constructor (__init__)…",
      icon: "symbol-constructor",
      run: () => generatePythonInit(view),
    },
    {
      id: "python.generateProperty",
      label: "Property…",
      icon: "field",
      run: () => generatePythonProperties(view),
    },
    {
      id: "python.overrideMethods",
      label: "Override Methods…",
      icon: "gutter-overridden",
      run: () => overridePythonMethods(view),
    },
  ];
  // Abstract methods come from bases: a class without any has nothing to implement.
  if (enclosingClass(lines, line))
    entries.push({
      id: "python.implementMethods",
      label: "Implement Methods…",
      icon: "gutter-implemented",
      run: () => implementPythonAbstractMethods(view),
    });
  return entries;
}
