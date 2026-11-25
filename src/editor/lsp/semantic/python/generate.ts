/**
 * Generate (⌘N) in a Python class: an `__init__` assigning the chosen class fields, and
 * properties (getter and setter) for the chosen attributes, besides Override / Implement Methods.
 */
import type { EditorView } from "@codemirror/view";
import { showHint } from "../../hint";
import { chooseMembers } from "../../memberChooser";
import type { GenerateEntry } from "../languages";
import {
  ID,
  classMembers,
  classHeader,
  codeLines,
  enclosingClass,
  implementPythonAbstractMethods,
  indentOf,
  insertMembers,
  isPython,
  overridePythonMethods,
  signatureParams,
  skipString,
} from "./members";

export interface PythonField {
  name: string;
  annotation: string | null;
  /** Default value text (a class field's value). */
  value: string | null;
  /** 1-based line declaring a class field. */
  line?: number;
}

const NAME = new RegExp(`^(${ID})\\s*`, "u");
const SELF_ATTR = new RegExp(`^\\s*self\\.(${ID})\\s*(?::\\s*([^=]+?))?\\s*=(?!=)`, "u");
const OWN_INIT_BASE = /(^|\.)(Enum|IntEnum|StrEnum|Flag|IntFlag|NamedTuple|TypedDict|BaseModel|BaseSettings|Struct)$/;
const OWN_INIT_DECORATOR = /^@(\w+\.)*(dataclass|define|frozen|mutable|s|attrs|dataclass_json)\b/;

/**
 * `text` (a statement after its name) split at its top-level `=`, with a trailing comment left out;
 * null when a bracket or string stays open at the end of the line (a value spanning lines).
 */
function splitAssignment(text: string): { annotation: string; value: string | null } | null {
  let depth = 0;
  let eq = -1;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      if (i >= text.length) return null;
    } else if (c === "#") {
      end = i;
      break;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "=" && depth === 0 && eq < 0 && !"=<>!:".includes(text[i - 1] ?? " ") && text[i + 1] !== "=") eq = i;
  }
  if (depth > 0 || text.slice(0, end).trimEnd().endsWith("\\")) return null;
  return eq < 0
    ? { annotation: text.slice(0, end).trim(), value: null }
    : { annotation: text.slice(0, eq).trim(), value: text.slice(eq + 1, end).trim() };
}

/** Fields declared in the body of the class headed at `header` (`x: int`, `x: int = 0`, `x = 0`). */
export function classFields(lines: readonly string[], header: number): PythonField[] {
  const body = codeLines(lines, header);
  const indent = body[0] ? indentOf(body[0].text) : -1;
  const out: PythonField[] = [];
  for (const { n, text } of body) {
    if (indentOf(text) !== indent) continue;
    const trimmed = text.trim();
    const name = NAME.exec(trimmed);
    if (!name || name[1]!.startsWith("__") || !/^[:=](?!=)/.test(trimmed.slice(name[0].length))) continue;
    const parts = splitAssignment(trimmed.slice(name[0].length));
    if (!parts) continue;
    const annotation = parts.annotation.replace(/^:\s*/, "") || null;
    if (annotation && /^(typing\.)?ClassVar\b/.test(annotation)) continue;
    out.push({ name: name[1]!, annotation, value: parts.value, line: n });
  }
  return out;
}

/**
 * Whether the class headed at `header` gets `__init__` from elsewhere: an enum, named tuple, typed
 * dict or pydantic model base, or a dataclass / attrs decorator.
 */
export function generatesOwnInit(lines: readonly string[], header: number): boolean {
  const bases = /\(([\s\S]*)\)/.exec(classHeader(lines, header).text)?.[1] ?? "";
  if (bases.split(",").some((b) => OWN_INIT_BASE.test(b.replace(/\[.*$/, "").trim()))) return true;
  for (let n = header - 1; n >= 1 && lines[n - 1]!.trim().startsWith("@"); n--)
    if (OWN_INIT_DECORATOR.test(lines[n - 1]!.trim())) return true;
  return false;
}

/**
 * Attributes assigned on `self` in the methods of the class headed at `header`, in order, with
 * the annotation written there or on the `__init__` parameter they are assigned from.
 */
export function instanceAttributes(lines: readonly string[], header: number): PythonField[] {
  const init = classMembers(lines, header).find((m) => m.name === "__init__");
  const params = new Map<string, string>();
  for (const p of (init && signatureParams(init.lines.filter((l) => !l.startsWith("@")).join(" "))) ?? []) {
    const m = new RegExp(`^(${ID})\\s*:\\s*([^=]+?)\\s*(?:=.*)?$`, "u").exec(p);
    if (m) params.set(m[1]!, m[2]!);
  }
  const out = new Map<string, PythonField>();
  for (const { text } of codeLines(lines, header)) {
    const m = SELF_ATTR.exec(text);
    if (!m) continue;
    const source = new RegExp(`=\\s*(${ID})\\s*(?:#.*)?$`, "u").exec(text)?.[1];
    const annotation = m[2]?.trim() ?? (source ? params.get(source) : undefined) ?? null;
    const known = out.get(m[1]!);
    if (!known) out.set(m[1]!, { name: m[1]!, annotation, value: null });
    else if (!known.annotation) known.annotation = annotation;
  }
  return [...out.values()];
}

/**
 * What Generate › Property offers: the class fields (not in classes that make their own `__init__`,
 * whose fields a property would replace), then the attributes assigned on `self`.
 */
export function propertyAttributes(lines: readonly string[], header: number): PythonField[] {
  const fields = generatesOwnInit(lines, header) ? [] : classFields(lines, header);
  const names = new Set(fields.map((f) => f.name));
  return [...fields, ...instanceAttributes(lines, header).filter((a) => !names.has(a.name))];
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

/**
 * The property for `attr`: a getter and setter over `self._name`, or over the attribute itself when
 * it is already private (`_x`, or name-mangled `__x`, which the class reads as written).
 */
export function propertyText(attr: PythonField, indent: string, unit: string): string {
  const name = attr.name.replace(/^_+/, "") || attr.name;
  const field = attr.name.startsWith("_") ? attr.name : `_${name}`;
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
  if (generatesOwnInit(lines, header)) {
    showHint(view, "Dataclasses, enums, named tuples, typed dicts and models get __init__ on their own");
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
  const attrs = propertyAttributes(lines, header).filter((a) => !taken.has(a.name.replace(/^_+/, "") || a.name));
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
  // A public class field becomes the property's private field (`x = 0` → `_x = 0`): the property
  // would otherwise replace it, losing its value.
  const renames = chosen.flatMap((a) => {
    if (!a.line || a.name.startsWith("_")) return [];
    const line = view.state.doc.line(a.line);
    return [{ from: line.from + indentOf(line.text), insert: "_" }];
  });
  insertMembers(
    view,
    lines,
    header,
    (indent, unit) => chosen.map((a) => propertyText(a, indent, unit)).join("\n\n"),
    [],
    false,
    renames,
  );
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
