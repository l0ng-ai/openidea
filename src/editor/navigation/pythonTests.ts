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
  const push = (s: PythonTestSubject) => {
    // `@overload`s and conditional definitions repeat a name: one test each.
    if (!out.some((o) => o.id === s.id)) out.push(s);
  };
  for (const item of outline) {
    const name = declaredName(item);
    if (CALLABLE.has(item.kind) && testable(name)) {
      push({ id: name, cls: null, name, lines: { from: item.range.start.line, to: item.range.end.line } });
    } else if (item.kind === "class" && !name.startsWith("_")) {
      for (const m of item.children) {
        const method = declaredName(m);
        if (!CALLABLE.has(m.kind) || !testable(method)) continue;
        push({
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

const IDENT = /^[A-Za-z_]\w*$/;

/**
 * The dotted module a test imports `path` from: relative to the innermost source root that
 * holds it (else the project, a leading `src/` dropped), `__init__` folded. Null when a part
 * is no identifier (`my-tool.py`), which no import can name.
 */
export function pythonImportPath(path: string, root: string | null, sourceRoots: readonly string[]): string | null {
  const base = [...sourceRoots].filter((r) => path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  let parts: string[];
  if (base)
    parts = path
      .slice(base.length + 1)
      .replace(/\.pyi?$/, "")
      .split("/");
  else {
    const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    parts = rel.replace(/\.pyi?$/, "").split("/");
    const src = parts.lastIndexOf("src");
    if (src >= 0 && src < parts.length - 1) parts.splice(0, src + 1);
  }
  if (parts.length > 1 && parts[parts.length - 1] === "__init__") parts.pop();
  return parts.length && parts.every((p) => IDENT.test(p)) ? parts.join(".") : null;
}

interface ImportStatement {
  /** First and last line (a parenthesised or `\\`-continued import spans several). */
  from: number;
  to: number;
  module: string | null;
  names: string[];
  /** `from m import a, b` on one line, which can be extended in place. */
  simple: boolean;
}

/** The file's top-level `import` / `from … import …` statements. */
function importStatements(lines: readonly string[]): ImportStatement[] {
  const out: ImportStatement[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(import|from)\s/.test(lines[i]!)) continue;
    let end = i;
    let body = lines[i]!.replace(/#.*/, "");
    const open = () => (body.match(/\(/g)?.length ?? 0) > (body.match(/\)/g)?.length ?? 0);
    while (end + 1 < lines.length && (open() || /\\\s*$/.test(body))) {
      end++;
      body += `\n${lines[end]!.replace(/#.*/, "")}`;
    }
    const m = /^from\s+(\S+)\s+import\s+([\s\S]*)$/.exec(body);
    const names = (m?.[2] ?? "")
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)
          .pop()!,
      )
      .filter(Boolean);
    out.push({ from: i, to: end, module: m?.[1] ?? null, names, simple: end === i && !!m && !/[()\\]/.test(body) });
    i = end;
  }
  return out;
}

/** The line after the file's leading comments (shebang, coding line) and module docstring. */
function headerEnd(lines: readonly string[]): number {
  let i = 0;
  while (i < lines.length && /^\s*(#.*)?$/.test(lines[i]!)) i++;
  const quote = /^[rRuUbB]{0,2}("""|'''|"|')/.exec(lines[i] ?? "");
  if (!quote) return lines.slice(0, i).some((l) => l.trim()) ? i : 0;
  const q = quote[1]!;
  const rest = lines[i]!.slice(quote[0].length);
  if (rest.includes(q)) return i + 1;
  for (let j = i + 1; j < lines.length; j++) if (lines[j]!.includes(q)) return j + 1;
  return lines.length;
}

/**
 * The edit that adds pytest stubs for `chosen` to the test file `text` (empty for a new
 * file): `from module import …` gains the names it lacks, methods of an existing `Test<Class>`
 * go to the end of that class, the rest to the end of the file. Null when every test exists.
 */
export function pytestStubEdit(
  text: string,
  module: string | null,
  chosen: readonly PythonTestSubject[],
  unit = "    ",
): TestFileEdit | null {
  const lines = text.split("\n");
  const starts = lineStarts(lines);
  const at = (line: number) => Math.min(starts[line]!, text.length);

  // Top-level tests and `class Test…:` blocks already in the file.
  const topTests = new Set<string>();
  const classes = new Map<string, { end: number; tests: Set<string>; indent: string | null }>();
  let current: { end: number; tests: Set<string>; indent: string | null } | null = null;
  lines.forEach((line, i) => {
    if (blank(line)) return;
    const indent = indentOf(line);
    if (indent === 0) {
      current = null;
      const cls = /^class\s+(\w+)/.exec(line);
      if (cls) classes.set(cls[1]!, (current = { end: i, tests: new Set(), indent: null }));
      const def = /^(?:async\s+)?def\s+(\w+)/.exec(line);
      if (def) topTests.add(def[1]!);
      return;
    }
    if (current) {
      current.end = i;
      current.indent ??= line.slice(0, indent);
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
  const names = module ? [...new Set(missing.map((s) => s.cls ?? s.name))].filter((n) => !imported.has(n)) : [];
  const own = statements.find((st) => st.simple && st.module === module);
  /** Inserts whole lines before line `line`, keeping a file without a final newline intact. */
  const insertLines = (line: number, insert: string): Change => {
    const from = at(line);
    return { from, insert: from === text.length && !text.endsWith("\n") ? `\n${insert.replace(/\n$/, "")}` : insert };
  };
  if (names.length && own) {
    const line = lines[own.from]!;
    const code = line.replace(/#.*$/, "").trimEnd();
    changes.push({ from: at(own.from) + code.length, insert: `, ${names.join(", ")}` });
  } else if (names.length) {
    const line = `from ${module} import ${names.join(", ")}\n`;
    const last = statements[statements.length - 1];
    if (last) changes.push(insertLines(last.to + 1, line));
    else if (!text.trim()) changes.push({ from: 0, insert: line });
    else {
      // After a shebang, coding line or module docstring; two blank lines before the code below.
      const h = headerEnd(lines);
      const next = lines[h];
      const after = next !== undefined && next.trim() ? "\n\n" : "";
      changes.push(h ? insertLines(h, `\n${line}${after}`) : { from: 0, insert: `${line}\n\n` });
    }
  }

  const stub = (s: PythonTestSubject, indent: string, inner = unit) =>
    `${indent}def ${testName(s)}(${s.cls ? "self" : ""}):\n${indent}${inner}assert False\n`;
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
    // The class's own indentation (tabs, two spaces), whatever the editor's unit.
    const existing = classes.get(`Test${cls}`)!;
    const indent = existing.indent ?? unit;
    for (const s of list) add(out, "\n", stub(s, indent, indent));
    const from = at(existing.end + 1);
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
      const head = names.length ? changes.pop()!.insert : "";
      const body = head ? tail.text : tail.text.replace(/^\n+/, "");
      const shift = head.length - (tail.text.length - body.length);
      change = { from: 0, to: text.length, insert: head + body };
      for (const rel of tail.bodies) bodies.push({ change, rel: rel + shift });
    } else {
      // A class insertion at the very end already ends the line.
      const lead =
        text.endsWith("\n") || changes.some((c) => c.from === text.length && c.insert.endsWith("\n")) ? "" : "\n";
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
