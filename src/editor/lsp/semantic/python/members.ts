/**
 * Python "Implement abstract methods" and "Override Methods": Python servers
 * (pyright, basedpyright) offer no such code actions. The bases of the class at
 * the caret are resolved with Go to Declaration; implemented abstract methods get
 * `pass` stubs, overrides call `super()`, at the end of the class body.
 */
import { indentUnit } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { commands } from "@/platform/ipc";
import type { ContributedIntention } from "@/editor/api";
import type { GenerateEntry } from "../languages";
import { docOf, lspRequest, reportLspError } from "../../lsp";
import { offsetToPos } from "../../positions";
import { readFileLines, withDocument } from "../../files";
import { showHint } from "../../hint";
import { chooseMembers } from "../../memberChooser";
import { importLine, importedFrom, neededImports, placeImports, topLevelBindings } from "./imports";

/** A Python identifier (letters of any script). */
const ID = "[\\p{L}_][\\p{L}\\p{N}_]*";
const CLASS_HEADER = new RegExp(`^(\\s*)class\\s+${ID}\\s*\\((.*)\\)\\s*:`, "u");
const CLASS = /^\s*class\s/;
const CLASS_NAME = new RegExp(`class\\s+(${ID})`, "u");
const DEF = new RegExp(`^\\s*(?:async\\s+)?def\\s+(${ID})`, "u");
const BASE = new RegExp(`(?:^|,)\\s*(${ID}(?:\\.${ID})*)\\s*(?=,|$|\\[)`, "gu");
const PARAM = new RegExp(`^(\\*{0,2})(${ID})`, "u");

const indentOf = (line: string) => line.length - line.trimStart().length;
const isPython = (view: EditorView) => docOf(view)?.uiMode === "Python";

/**
 * 1-based number of the class header line enclosing `line` (or on it); null unless it has bases
 * (or, with `any`, unless there is one).
 */
export function enclosingClass(lines: readonly string[], line: number, any = false): number | null {
  let limit = Infinity;
  for (let n = line; n >= 1; n--) {
    const text = lines[n - 1]!;
    if (!text.trim()) continue;
    const indent = indentOf(text);
    if (n !== line && indent >= limit) continue;
    if (CLASS.test(text)) return any || CLASS_HEADER.test(text) ? n : null;
    limit = Math.min(limit, indent);
    if (indent === 0 && n !== line) return null;
  }
  return null;
}

/** Last 1-based line of the body of the class headed at `header`. */
function bodyEnd(lines: readonly string[], header: number): number {
  const indent = indentOf(lines[header - 1]!);
  let last = header;
  let quote: string | null = null;
  for (let n = header + 1; n <= lines.length; n++) {
    const text = lines[n - 1]!;
    // Lines inside a triple-quoted string belong to it, however indented.
    const inString = quote !== null;
    for (const q of text.match(/"""|'''/g) ?? []) {
      if (quote === null) quote = q;
      else if (q === quote) quote = null;
    }
    if (inString) {
      last = n;
      continue;
    }
    if (!text.trim()) continue;
    if (indentOf(text) <= indent) break;
    last = n;
  }
  return last;
}

export interface PythonMember {
  name: string;
  abstract: boolean;
  /** Decorators (without `@abstractmethod`) and the signature, dedented. */
  lines: string[];
  /** Decorated `@overload` / `@final`: not something to override. */
  hidden?: boolean;
}

/** Methods declared directly in the class headed at `header` (1-based). */
export function classMembers(lines: readonly string[], header: number): PythonMember[] {
  const end = bodyEnd(lines, header);
  const out: PythonMember[] = [];
  let memberIndent = -1;
  let decorators: string[] = [];
  for (let n = header + 1; n <= end; n++) {
    const text = lines[n - 1]!;
    if (!text.trim()) continue;
    const indent = indentOf(text);
    if (memberIndent < 0) memberIndent = indent;
    if (indent !== memberIndent) continue;
    const trimmed = text.trim();
    if (trimmed.startsWith("@")) {
      decorators.push(trimmed);
      continue;
    }
    const def = DEF.exec(text);
    if (def) {
      // The signature may span lines: up to the `:` closing it; a body on the same line
      // (`def f(self) -> int: ...`, `def go(self): return 1`) is left out.
      const sig: string[] = [];
      for (let m = n; m <= end; m++) {
        const part = lines[m - 1]!;
        sig.push(part.slice(Math.min(memberIndent, indentOf(part))));
        const joined = sig.join("\n");
        const colon = headerColon(joined);
        if (colon >= 0) {
          sig[sig.length - 1] = sig[sig.length - 1]!.slice(
            0,
            colon + 1 - (joined.length - sig[sig.length - 1]!.length),
          );
          break;
        }
      }
      const abstract = decorators.some((d) => /^@(abc\.)?abstract(method|property)\b/.test(d));
      out.push({
        name: def[1]!,
        abstract,
        hidden: decorators.some((d) => /^@(typing\.|typing_extensions\.)?(overload|final)\b/.test(d)),
        lines: [
          ...decorators
            .filter((d) => !/^@(abc\.)?abstractmethod\b/.test(d))
            .map((d) => d.replace(/^@(abc\.)?abstractproperty\b/, "@property")),
          ...sig,
        ],
      });
    }
    decorators = [];
  }
  return out;
}

/** Base class names of a header and where each starts in the line. */
function bases(header: string): Array<{ name: string; col: number }> {
  const m = CLASS_HEADER.exec(header);
  if (!m) return [];
  const start = header.indexOf("(") + 1;
  const out: Array<{ name: string; col: number }> = [];
  for (const b of m[2]!.matchAll(BASE)) {
    const name = b[1]!;
    if (name === "object" || name.includes("=")) continue;
    // The last segment of `abc.ABC`: that's what Go to Declaration resolves.
    const col = start + b.index! + b[0].indexOf(name) + name.lastIndexOf(".") + 1;
    out.push({ name, col });
  }
  return out;
}

/** Stub text for `members`, indented by `indent`. */
export function memberStubs(members: readonly PythonMember[], indent: string, unit: string): string {
  return members.map((m) => [...m.lines.map((l) => indent + l), `${indent}${unit}pass`].join("\n")).join("\n\n");
}

async function abstractMembersOfBases(view: EditorView, header: number): Promise<PythonMember[]> {
  const doc = docOf(view)!;
  const state = view.state;
  const line = state.doc.line(header);
  const out = new Map<string, PythonMember>();
  for (const base of bases(line.text)) {
    const pos = offsetToPos(state.doc, line.from + base.col);
    const [loc] = await lspRequest(() => commands.lspGoto(doc.doc, pos, "definition"));
    if (!loc) continue;
    const lines = await readFileLines(loc.path);
    if (!lines) continue;
    const target = enclosingClass(lines, loc.range.start.line + 1);
    if (!target) continue;
    for (const m of classMembers(lines, target)) if (m.abstract && !out.has(m.name)) out.set(m.name, m);
  }
  return [...out.values()];
}

/** ⌃I / the intention: stubs for the abstract methods of the bases the class lacks. */
export async function implementPythonAbstractMethods(view: EditorView): Promise<boolean> {
  if (!isPython(view)) return false;
  const lines = view.state.doc.toJSON();
  const header = enclosingClass(lines, view.state.doc.lineAt(view.state.selection.main.head).number);
  if (!header) return false;
  let abstract: PythonMember[];
  try {
    abstract = await abstractMembersOfBases(view, header);
  } catch (e) {
    reportLspError(view, e, true);
    return true;
  }
  const state = view.state;
  if (state.doc.toJSON().join("\n") !== lines.join("\n")) return true;
  const own = new Set(classMembers(lines, header).map((m) => m.name));
  const missing = abstract.filter((m) => !own.has(m.name));
  if (!missing.length) {
    showHint(view, "No abstract methods to implement");
    return true;
  }
  insertMembers(view, lines, header, (indent, unit) => memberStubs(missing, indent, unit));
  return true;
}

/** Inserts `text(indent, unit)` at the end of the body of the class headed at `header` (1-based). */
function insertMembers(
  view: EditorView,
  lines: readonly string[],
  header: number,
  text: (indent: string, unit: string) => string,
  imports: readonly string[] = [],
) {
  const state = view.state;
  const end = bodyEnd(lines, header);
  const unit = state.facet(indentUnit) || "    ";
  const bodyLines = [];
  for (let n = header + 1; n <= end; n++) if (lines[n - 1]!.trim()) bodyLines.push(n);
  const first = bodyLines[0] ? lines[bodyLines[0] - 1]! : null;
  const indent = first
    ? first.slice(0, indentOf(first))
    : lines[header - 1]!.slice(0, indentOf(lines[header - 1]!)) + unit;
  const stubs = text(indent, unit);
  // A body that is only `pass` / `...` is replaced.
  const placeholder = bodyLines.length === 1 && /^\s*(pass|\.\.\.)\s*$/.test(first!);
  const changes = !bodyLines.length
    ? { from: state.doc.line(header).to, insert: `\n${stubs}` }
    : placeholder
      ? { from: state.doc.line(bodyLines[0]!).from, to: state.doc.line(end).to, insert: stubs }
      : { from: state.doc.line(end).to, insert: `\n\n${stubs}` };
  const { appended, added } = placeImports(lines, imports);
  const importChanges = [...appended].map(([n, text]) => ({ from: state.doc.line(n + 1).to, insert: text }));
  if (added.length) {
    const before = importLine(lines);
    importChanges.push(
      before < state.doc.lines
        ? { from: state.doc.line(before + 1).from, insert: `${added.join("\n")}\n` }
        : { from: state.doc.length, insert: `\n${added.join("\n")}` },
    );
  }
  view.dispatch({ changes: [...importChanges, changes], userEvent: "input.complete", scrollIntoView: true });
}

/** A base class of the class at the caret and the methods it declares. */
export interface PythonBase {
  name: string;
  members: PythonMember[];
  /** Lines of the file declaring it. */
  lines: readonly string[];
  /** Where its file's own definitions are imported from; "" for the current file, null when unknown. */
  module: string | null;
}

/** How many ancestor classes are looked at (typeshed hierarchies run deep). */
const MAX_ANCESTORS = 30;

/** Ancestors of the class headed at `header`, nearest first (breadth-first, each once), via Go to Declaration. */
async function ancestors(view: EditorView, header: number): Promise<PythonBase[]> {
  const doc = docOf(view)!;
  const queue: Array<{ path: string | null; lines: readonly string[]; header: number; module: string | null }> = [
    { path: null, lines: view.state.doc.toJSON(), header, module: "" },
  ];
  const seen = new Set<string>();
  const out: PythonBase[] = [];
  while (queue.length && out.length < MAX_ANCESTORS) {
    const cls = queue.shift()!;
    for (const base of bases(cls.lines[cls.header - 1]!)) {
      const pos = { line: cls.header - 1, col: base.col };
      const goto = (id: number) => lspRequest(() => commands.lspGoto(id, pos, "definition"));
      const [loc] = cls.path ? await withDocument(cls.path, goto) : await goto(doc.doc);
      if (!loc) continue;
      const key = `${loc.path}:${loc.range.start.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lines = await readFileLines(loc.path);
      const target = lines && enclosingClass(lines, loc.range.start.line + 1, true);
      if (!lines || !target) continue;
      const name = CLASS_NAME.exec(lines[target - 1]!)?.[1];
      if (!name) continue;
      if (name === "object") continue;
      // Imported in the file naming it, else declared in that file (and imported from where it is).
      const from = importedFrom(cls.lines, base.name);
      const module = from === null ? cls.module : cls.path && from.startsWith(".") ? null : from;
      out.push({ name, members: classMembers(lines, target), lines, module });
      queue.push({ path: loc.path, lines, header: target, module });
    }
  }
  return out;
}

/** Index of the quote closing the string literal that opens at `i` of `text`, or `text.length`. */
function skipString(text: string, i: number): number {
  const quote = text[i]!;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === quote) return j;
  }
  return text.length;
}

/** Index of the `:` that closes a `def` header in `text` (outside brackets, strings and comments), or -1. */
export function headerColon(text: string): number {
  let depth = 0;
  let opened = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") i = skipString(text, i);
    else if (c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
    } else if ("([{".includes(c)) {
      depth++;
      opened = true;
    } else if (")]}".includes(c)) depth--;
    else if (c === ":" && depth === 0 && opened) return i;
  }
  return -1;
}

/**
 * The parameters of `signature` (a `def`, possibly joined from several lines), trimmed; null when
 * unclosed. Commas in strings, brackets and between a `lambda` and its `:` do not split.
 */
export function signatureParams(signature: string): string[] | null {
  const open = signature.indexOf("(");
  if (open < 0) return null;
  const params: string[] = [];
  let depth = 0;
  let start = open + 1;
  let lambda = false;
  for (let i = open; i < signature.length; i++) {
    const c = signature[i]!;
    if (c === '"' || c === "'") i = skipString(signature, i);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) {
      params.push(signature.slice(start, i));
      return params.map((p) => p.trim()).filter(Boolean);
    } else if (depth === 1 && /^lambda\b/.test(signature.slice(i, i + 7)) && !/[\p{L}\p{N}_]/u.test(signature[i - 1]!))
      lambda = true;
    else if (c === ":" && depth === 1 && lambda) lambda = false;
    else if (c === "," && depth === 1 && !lambda) {
      params.push(signature.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/**
 * The names an override copied from `member` uses besides its own and its parameters': in its
 * decorators, annotations, defaults and return annotation (string annotations included).
 */
export function signatureNames(member: PythonMember): string[] {
  const decorators = member.lines.filter((l) => l.startsWith("@"));
  const joined = member.lines.filter((l) => !l.startsWith("@")).join(" ");
  const parts = [...decorators.map((d) => d.slice(1))];
  for (const p of signatureParams(joined) ?? []) parts.push(p.replace(PARAM, ""));
  const close = joined.lastIndexOf(")", headerColon(joined));
  parts.push(joined.slice(close + 1));
  return [...new Set(parts.join(" ").match(new RegExp(ID, "gu")) ?? [])];
}

/**
 * The argument list passing the parameters of `signature` on, as the `super()` call of an
 * override: keyword-only parameters by keyword, `self` / `cls` dropped.
 */
export function forwardedArgs(signature: string): string | null {
  const params = signatureParams(signature);
  if (!params) return null;
  let keyword = false;
  const args: string[] = [];
  for (const [i, raw] of params.entries()) {
    if (raw === "/") continue;
    if (raw === "*") {
      keyword = true;
      continue;
    }
    const m = PARAM.exec(raw);
    if (!m) continue;
    if (i === 0 && !m[1] && (m[2] === "self" || m[2] === "cls")) continue;
    if (m[1] === "*") keyword = true;
    args.push(m[1] ? m[1] + m[2] : keyword ? `${m[2]}=${m[2]}` : m[2]!);
  }
  return args.join(", ");
}

/**
 * An override of `member` in the class named `owner`: its decorators and signature, and a body
 * calling the base; null when the signature cannot be read.
 */
export function overrideText(member: PythonMember, owner: string, indent: string, unit: string): string | null {
  const decorators = member.lines.filter((l) => l.startsWith("@"));
  const signature = member.lines.filter((l) => !l.startsWith("@"));
  const joined = signature.join(" ");
  const isStatic = decorators.some((d) => /^@(builtins\.)?staticmethod\b/.test(d));
  const isProperty = decorators.some((d) => /^@((builtins|functools)\.)?(property|cached_property)\b/.test(d));
  // ponytail: a static method has no `self` for `super()`; a nested class needs `Outer.Owner` here.
  const target = isStatic ? `super(${owner}, ${owner})` : "super()";
  const args = forwardedArgs(joined);
  if (!isProperty && args === null) return null;
  const call = isProperty ? `${target}.${member.name}` : `${target}.${member.name}(${args})`;
  const awaited = /^\s*async\s/.test(joined) ? `await ${call}` : call;
  const returns = member.name !== "__init__" && !/->\s*None\s*:\s*$/.test(joined);
  return [...member.lines.map((l) => indent + l), `${indent}${unit}${returns ? "return " : ""}${awaited}`].join("\n");
}

/** ⌃O: the base classes' methods the class does not define, chosen in a dialog, as overrides calling `super()`. */
export async function overridePythonMethods(view: EditorView): Promise<boolean> {
  if (!isPython(view)) return false;
  const lines = view.state.doc.toJSON();
  const header = enclosingClass(lines, view.state.doc.lineAt(view.state.selection.main.head).number, true);
  if (!header) return false;
  let found: PythonBase[];
  try {
    found = await ancestors(view, header);
  } catch (e) {
    reportLspError(view, e, true);
    return true;
  }
  const taken = new Set(classMembers(lines, header).map((m) => m.name));
  const choices: Array<{ base: PythonBase; member: PythonMember }> = [];
  for (const base of found)
    for (const member of base.members) {
      // `__x` is name-mangled: a subclass cannot override it.
      if (member.hidden || taken.has(member.name) || /^__[\p{L}\p{N}_]*[^_]_?$/u.test(member.name)) continue;
      if (overrideText(member, "C", "", "") === null) continue;
      taken.add(member.name);
      choices.push({ base, member });
    }
  if (!choices.length) {
    showHint(view, "No methods to override");
    return true;
  }
  const ids = await chooseMembers(view, {
    title: "Select Methods to Override",
    members: choices.map(({ base, member }, i) => {
      const sig = member.lines.filter((l) => !l.startsWith("@")).join(" ");
      return {
        id: String(i),
        label: member.name,
        detail: sig.slice(sig.indexOf("(")).replace(/:\s*$/, ""),
        icon: member.abstract ? "gutter-implemented" : "gutter-overridden",
        group: base.name,
      };
    }),
  });
  if (!ids?.length) return true;
  if (view.state.doc.toJSON().join("\n") !== lines.join("\n")) return true;
  const chosen = ids.map((id) => choices[Number(id)]!);
  const current = topLevelBindings(lines);
  const imports = new Set<string>();
  for (const { base, member } of chosen)
    for (const i of neededImports(signatureNames(member), current, topLevelBindings(base.lines), base.module))
      imports.add(i);
  const owner = CLASS_NAME.exec(lines[header - 1]!)![1]!;
  insertMembers(
    view,
    lines,
    header,
    (indent, unit) => chosen.map(({ member }) => overrideText(member, owner, indent, unit)!).join("\n\n"),
    [...imports],
  );
  return true;
}

/** Generate (⌘N) in a Python class: Override / Implement Methods. */
export function pythonGenerateEntries(view: EditorView): GenerateEntry[] {
  if (!isPython(view)) return [];
  const lines = view.state.doc.toJSON();
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  if (!enclosingClass(lines, line, true)) return [];
  const entries: GenerateEntry[] = [
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

/** The bulb on a Python class header with bases. */
export function pythonMemberIntentions(view: EditorView): ContributedIntention[] {
  if (!isPython(view)) return [];
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!bases(line.text).length) return [];
  return [
    {
      id: "python.implementAbstract",
      label: "Implement abstract methods",
      icon: "bulb",
      run: () => void implementPythonAbstractMethods(view),
    },
  ];
}
