/**
 * Python "Implement abstract methods": Python servers (pyright, basedpyright)
 * offer no such code action. The bases of the class at the caret are resolved
 * with Go to Declaration; their `@abstractmethod`s the class lacks get stubs
 * at the end of its body.
 */
import { indentUnit } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { commands } from "@/platform/ipc";
import type { ContributedIntention } from "@/editor/api";
import { docOf, lspRequest, reportLspError } from "../../lsp";
import { offsetToPos } from "../../positions";
import { readFileLines } from "../../files";
import { showHint } from "../../hint";

const CLASS_HEADER = /^(\s*)class\s+\w+\s*\((.*)\)\s*:/;
const CLASS = /^\s*class\s/;
const DEF = /^\s*(?:async\s+)?def\s+(\w+)/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isPython = (view: EditorView) => docOf(view)?.uiMode === "Python";

/** 1-based number of the class header line enclosing `line` (or on it); null unless it has bases. */
export function enclosingClass(lines: readonly string[], line: number): number | null {
  let limit = Infinity;
  for (let n = line; n >= 1; n--) {
    const text = lines[n - 1]!;
    if (!text.trim()) continue;
    const indent = indentOf(text);
    if (n !== line && indent >= limit) continue;
    if (CLASS.test(text)) return CLASS_HEADER.test(text) ? n : null;
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
      // The signature may span lines: up to the `:` closing it.
      const sig: string[] = [];
      let depth = 0;
      for (let m = n; m <= end; m++) {
        const part = lines[m - 1]!;
        sig.push(part.slice(Math.min(memberIndent, indentOf(part))));
        for (const ch of part) depth += ch === "(" || ch === "[" ? 1 : ch === ")" || ch === "]" ? -1 : 0;
        if (depth <= 0 && /:\s*(#.*)?$|:\s*\.\.\.\s*$|:\s*\S/.test(part)) break;
      }
      // `def f(self) -> int: ...` keeps only the signature.
      sig[sig.length - 1] = sig[sig.length - 1]!.replace(/:\s*(\.\.\.|pass)?\s*(#.*)?$/, ":");
      const abstract = decorators.some((d) => /^@(abc\.)?abstract(method|property)\b/.test(d));
      out.push({
        name: def[1]!,
        abstract,
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
  for (const b of m[2]!.matchAll(/(?:^|,)\s*([A-Za-z_][\w.]*)\s*(?=,|$|\[)/g)) {
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
  const end = bodyEnd(lines, header);
  const unit = state.facet(indentUnit) || "    ";
  const bodyLines = [];
  for (let n = header + 1; n <= end; n++) if (lines[n - 1]!.trim()) bodyLines.push(n);
  const first = bodyLines[0] ? lines[bodyLines[0] - 1]! : null;
  const indent = first
    ? first.slice(0, indentOf(first))
    : lines[header - 1]!.slice(0, indentOf(lines[header - 1]!)) + unit;
  const stubs = memberStubs(missing, indent, unit);
  // A body that is only `pass` / `...` is replaced.
  const placeholder = bodyLines.length === 1 && /^\s*(pass|\.\.\.)\s*$/.test(first!);
  const changes = !bodyLines.length
    ? { from: state.doc.line(header).to, insert: `\n${stubs}` }
    : placeholder
      ? { from: state.doc.line(bodyLines[0]!).from, to: state.doc.line(end).to, insert: stubs }
      : { from: state.doc.line(end).to, insert: `\n\n${stubs}` };
  view.dispatch({ changes, userEvent: "input.complete", scrollIntoView: true });
  return true;
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
