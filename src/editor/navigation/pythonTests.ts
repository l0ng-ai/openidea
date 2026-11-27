/**
 * Create Test for a Python module (PyCharm's Create Test dialog): pytest stubs for the
 * chosen functions and methods, added to the module's test file without touching what
 * is already there.
 */
import type { OutlineItem } from "@/platform/ipc";
import { declaredName } from "@/editor/core/copyReference";

export interface PythonTestSubject {
  /** `name` for a function, `Class.name` for a method. */
  id: string;
  cls: string | null;
  name: string;
  /** Extent of the function, or of its class (0-based lines), for preselecting what is at the caret. */
  lines: { from: number; to: number; clsFrom?: number; clsTo?: number };
}

const CALLABLE = new Set(["function", "method", "constructor"]);
const testable = (name: string) => !name.startsWith("_") || name === "__init__";

/** The module's top-level functions and its top-level classes' methods, in source order. */
export function pythonTestSubjects(outline: readonly OutlineItem[]): PythonTestSubject[] {
  const out: PythonTestSubject[] = [];
  for (const item of outline) {
    const name = declaredName(item);
    if (CALLABLE.has(item.kind) && testable(name)) {
      out.push({ id: name, cls: null, name, lines: { from: item.range.start.line, to: item.range.end.line } });
    } else if (item.kind === "class" && !name.startsWith("_")) {
      for (const m of item.children) {
        const method = declaredName(m);
        if (!CALLABLE.has(m.kind) || !testable(method)) continue;
        out.push({
          id: `${name}.${method}`,
          cls: name,
          name: method,
          lines: {
            from: m.range.start.line,
            to: m.range.end.line,
            clsFrom: item.range.start.line,
            clsTo: item.range.end.line,
          },
        });
      }
    }
  }
  return out;
}

/** Subjects at `line`: the function or method there, else every method of the class there. */
export function subjectsAtLine(subjects: readonly PythonTestSubject[], line: number): PythonTestSubject[] {
  const own = subjects.filter((s) => s.lines.from <= line && line <= s.lines.to);
  if (own.length) return own;
  return subjects.filter((s) => s.lines.clsFrom !== undefined && s.lines.clsFrom <= line && line <= s.lines.clsTo!);
}

const testName = (s: PythonTestSubject) => `test_${s.name === "__init__" ? "init" : s.name}`;

interface Change {
  from: number;
  to?: number;
  insert: string;
}

export interface TestFileEdit {
  changes: Change[];
  /** Caret in the edited text: the body of the first new test. */
  caret: number;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string) => !line.trim() || line.trimStart().startsWith("#");

/** Line start offsets of `text`, plus its length. */
function lineStarts(lines: readonly string[]): number[] {
  const starts = [0];
  for (const l of lines) starts.push(starts[starts.length - 1]! + l.length + 1);
  return starts;
}

/**
 * The file's top-level `import …` / `from … import …` statements (lines `first`..`last`, a
 * parenthesized or backslash-continued list included) and the names `from` imports bind.
 */
function importStatements(lines: readonly string[]): Array<{ first: number; last: number; names: string[] }> {
  const out: Array<{ first: number; last: number; names: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(import|from)\s/.test(lines[i]!)) continue;
    const first = i;
    let text = lines[i]!.replace(/#.*$/, "");
    const open = () => (text.includes("(") && !text.includes(")")) || /\\\s*$/.test(text);
    while (open() && i + 1 < lines.length) text = `${text.replace(/\\\s*$/, "")} ${lines[++i]!.replace(/#.*$/, "")}`;
    const from = /^from\s+\S+\s+import\s+\(?([^)]*)/.exec(text);
    const names = (from?.[1] ?? "")
      .split(",")
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)
          .pop()!,
      )
      .filter(Boolean);
    out.push({ first, last: i, names });
  }
  return out;
}

/**
 * The edit that adds pytest stubs for `chosen` to the test file `text` (empty for a new
 * file): `from module import …` gains the names it lacks, methods of an existing `Test<Class>`
 * go to the end of that class, the rest to the end of the file. Null when every test exists.
 */
export function pytestStubEdit(
  text: string,
  module: string,
  chosen: readonly PythonTestSubject[],
  unit = "    ",
): TestFileEdit | null {
  const lines = text.split("\n");
  const starts = lineStarts(lines);
  const at = (line: number) => Math.min(starts[line]!, text.length);

  // Top-level tests and `class Test…:` blocks already in the file.
  const topTests = new Set<string>();
  const classes = new Map<string, { end: number; tests: Set<string> }>();
  let current: { end: number; tests: Set<string> } | null = null;
  lines.forEach((line, i) => {
    if (blank(line)) return;
    const indent = indentOf(line);
    if (indent === 0) {
      current = null;
      const cls = /^class\s+(\w+)/.exec(line);
      if (cls) classes.set(cls[1]!, (current = { end: i, tests: new Set() }));
      const def = /^(?:async\s+)?def\s+(\w+)/.exec(line);
      if (def) topTests.add(def[1]!);
      return;
    }
    if (current) {
      current.end = i;
      const def = /^\s+(?:async\s+)?def\s+(\w+)/.exec(line);
      if (def) current.tests.add(def[1]!);
    }
  });

  const missing = chosen.filter((s) =>
    s.cls === null ? !topTests.has(testName(s)) : !classes.get(`Test${s.cls}`)?.tests.has(testName(s)),
  );
  if (!missing.length) return null;

  const changes: Change[] = [];
  // Where each new stub's body starts, relative to the start of its change's text.
  const bodies: Array<{ change: Change; rel: number }> = [];

  // Imports: names the file already imports, from this module or another (`from pkg import X`), stay as they are.
  const statements = importStatements(lines);
  const imported = new Set(statements.flatMap((st) => st.names));
  const names = [...new Set(missing.map((s) => s.cls ?? s.name))].filter((n) => !imported.has(n));
  const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importRe = new RegExp(`^from\\s+${escaped}\\s+import\\s+([^()#\\\\]+?)\\s*(#.*)?$`);
  const importLine = statements.find((st) => st.first === st.last && importRe.test(lines[st.first]!))?.first ?? -1;
  if (names.length && importLine >= 0) {
    const m = importRe.exec(lines[importLine]!)!;
    changes.push({ from: at(importLine) + m[0].indexOf(m[1]!) + m[1]!.length, insert: `, ${names.join(", ")}` });
  } else if (names.length) {
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const st = statements.find((s) => s.first === i);
      if (st) last = i = st.last;
      else if (!blank(l) && indentOf(l) === 0 && !/^["']/.test(l)) break;
    }
    const line = `from ${module} import ${names.join(", ")}\n`;
    changes.push(
      last >= 0 ? { from: at(last + 1), insert: line } : { from: 0, insert: text.trim() ? `${line}\n\n` : line },
    );
  }

  const stub = (s: PythonTestSubject, indent: string) =>
    `${indent}def ${testName(s)}(${s.cls ? "self" : ""}):\n${indent}${unit}assert False\n`;
  /** Appends `piece` to `out`, noting where its body starts. */
  const add = (out: { text: string; bodies: number[] }, sep: string, piece: string) => {
    out.text += sep;
    out.bodies.push(out.text.length + piece.indexOf("assert"));
    out.text += piece;
  };

  // Methods of classes that already have a `Test<Class>`: at the end of that class.
  const newTop = missing.filter((s) => s.cls === null);
  const newClasses = new Map<string, PythonTestSubject[]>();
  const intoClasses = new Map<string, PythonTestSubject[]>();
  for (const s of missing) {
    if (s.cls === null) continue;
    const map = classes.has(`Test${s.cls}`) ? intoClasses : newClasses;
    map.set(s.cls, [...(map.get(s.cls) ?? []), s]);
  }
  for (const [cls, list] of intoClasses) {
    const out = { text: "", bodies: [] as number[] };
    for (const s of list) add(out, "\n", stub(s, unit));
    const from = at(classes.get(`Test${cls}`)!.end + 1);
    // A class on the file's last line without a newline after it.
    const lead = from === text.length && !text.endsWith("\n") ? "\n" : "";
    const change = { from, insert: lead + out.text };
    changes.push(change);
    for (const rel of out.bodies) bodies.push({ change, rel: rel + lead.length });
  }

  // New top-level tests, then new `Test<Class>` blocks, at the end of the file.
  const tail = { text: "", bodies: [] as number[] };
  for (const s of newTop) add(tail, "\n\n", stub(s, ""));
  for (const [cls, list] of newClasses) {
    tail.text += `\n\nclass Test${cls}:\n`;
    list.forEach((s, i) => add(tail, i ? "\n" : "", stub(s, unit)));
  }
  if (tail.text) {
    let change: Change;
    if (!text.trim()) {
      // A new file: the stubs follow the import line, which becomes part of this change.
      const head = changes.pop()!;
      change = { from: 0, to: text.length, insert: head.insert + tail.text };
      for (const rel of tail.bodies) bodies.push({ change, rel: rel + head.insert.length });
    } else {
      // A class insertion at the very end already ends the line.
      const lead = text.endsWith("\n") || changes.some((c) => c.from === text.length) ? "" : "\n";
      change = { from: text.length, insert: lead + tail.text };
      for (const rel of tail.bodies) bodies.push({ change, rel: rel + lead.length });
    }
    changes.push(change);
  }

  // Caret: the first new body in the document, in edited-text coordinates.
  const sorted = [...changes].sort((a, b) => a.from - b.from);
  const finalOffset = (change: Change, rel: number) => {
    let shift = 0;
    for (const c of sorted) {
      if (c === change) break;
      shift += c.insert.length - ((c.to ?? c.from) - c.from);
    }
    return change.from + shift + rel;
  };
  const caret = Math.min(...bodies.map((b) => finalOffset(b.change, b.rel)));
  return { changes: sorted, caret };
}
