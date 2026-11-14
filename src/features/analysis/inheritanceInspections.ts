/**
 * Python inheritance inspections, computed from the IDE's own inheritance graph
 * (`inheritanceGraph.ts`) instead of a language server: basedpyright and pyrefly
 * declare no `typeHierarchyProvider`, and no server checks Python's class rules.
 *
 * Everything here is decided from the graph, the outline and the file lines. A
 * base name the graph does not know (a class outside the project: `dict`, a
 * library base) makes "@override declares nothing" undecidable, so that class is
 * left alone rather than guessed about: a missing warning is cheaper than a
 * wrong one.
 */
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { onServerSettled } from "@/editor/lsp/availability";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { readManyFileLines, withDocument } from "@/editor/lsp/files";
import { lspRequest } from "@/editor/lsp/lsp";
import {
  ancestors,
  declarationKey,
  forgetInheritanceGraph,
  importBindings,
  projectPythonIndex,
  type ImportBinding,
  type InheritanceIndex,
} from "@/editor/navigation/inheritanceGraph";
import { baseName } from "@/editor/navigation/structureNav";
import { tx } from "@/platform/i18n";
import {
  commands,
  isCancelled,
  isTauri,
  onIdeEvent,
  type ClassInheritance,
  type Diagnostic,
  type OutlineItem,
  type Range,
  type Severity,
  type SymbolKind,
} from "@/platform/ipc";
import {
  PYTHON_ABSTRACT_METHOD_PRODUCER,
  PYTHON_CIRCULAR_BASES_PRODUCER,
  PYTHON_OVERRIDE_PRODUCER,
  PYTHON_REDUNDANT_OVERRIDE_PRODUCER,
  enabledByDefault,
  inspectionProfile,
  producerInspectionId,
  subscribeInspectionProfile,
} from "@/platform/inspections";
import { useProject } from "@/platform/project";

/** How far up an inheritance chain a rule looks. */
const MAX_DEPTH = 16;
const DEBOUNCE_MS = 500;

const PRODUCERS = [
  PYTHON_CIRCULAR_BASES_PRODUCER,
  PYTHON_OVERRIDE_PRODUCER,
  PYTHON_ABSTRACT_METHOD_PRODUCER,
  PYTHON_REDUNDANT_OVERRIDE_PRODUCER,
] as const;

/** What an inspection needs from the editor: the open file, its outline and the project graph. */
export interface InheritanceInspectionDeps {
  path: string;
  /** The open document's lines (unsaved edits included). */
  lines: readonly string[];
  /** The open document's outline. */
  outline: readonly OutlineItem[];
  /** The project graph, indexed; reused across edits. */
  index: InheritanceIndex;
  readFiles: (paths: readonly string[]) => Promise<Map<string, string[] | null>>;
  /** The outline of another file of the project, opened for the call only. */
  outlineOf: (path: string) => Promise<OutlineItem[]>;
}

/** Every problem the four Python inheritance inspections report in the open document. */
export async function inheritanceDiagnostics(deps: InheritanceInspectionDeps): Promise<Diagnostic[]> {
  const view = new ProjectView(deps);
  const out: Diagnostic[] = [];
  for (const decl of view.classesInFile()) {
    const facts = await view.classFacts(decl);
    if (!facts) continue;
    out.push(...(await circularInheritance(view, facts)));
    out.push(...(await overrideConsistency(view, facts)));
    out.push(...(await missingAbstractMethods(view, facts)));
    out.push(...(await redundantOverrides(view, facts)));
  }
  return out;
}

// --- the graph as the inspections see it ------------------------------------

interface FileFacts {
  lines: readonly string[] | null;
  outline: readonly OutlineItem[] | null;
}

interface ClassFacts {
  decl: ClassInheritance;
  /** The class in the document's outline. */
  item: OutlineItem;
  /** Methods declared directly in it. */
  methods: OutlineItem[];
}

interface Members {
  lines: readonly string[];
  /** Every member the class declares (methods, properties, fields, nested types). */
  all: OutlineItem[];
  methods: OutlineItem[];
}

const METHOD_KINDS = new Set<SymbolKind>(["function", "method", "constructor"]);

class ProjectView {
  private files = new Map<string, Promise<FileFacts>>();
  private bases = new Map<string, Promise<{ decls: ClassInheritance[]; unresolved: boolean }>>();
  private members = new Map<string, Promise<Members | null>>();

  constructor(readonly deps: InheritanceInspectionDeps) {}

  /** The classes the graph declares in the open document, in source order. */
  classesInFile(): ClassInheritance[] {
    const out: ClassInheritance[] = [];
    for (const classes of this.deps.index.byName.values())
      for (const cls of classes) if (cls.path === this.deps.path) out.push(cls);
    return out.sort((a, b) => a.line - b.line || a.col - b.col);
  }

  /**
   * The class as the document has it now, or null when the graph no longer
   * matches it (the header reads other bases than the indexed ones).
   */
  async classFacts(decl: ClassInheritance): Promise<ClassFacts | null> {
    const members = await this.classMembers(decl);
    if (!members) return null;
    const item = await this.classItem(decl);
    if (!item) return null;
    const written = writtenBases(members.lines, item);
    if (written && !sameNames(written, decl.bases)) return null;
    return { decl, item, methods: methodsOf(item) };
  }

  async classItem(decl: ClassInheritance): Promise<OutlineItem | null> {
    const file = await this.file(decl.path);
    return file.outline ? outlineClass(file.outline, decl) : null;
  }

  file(path: string): Promise<FileFacts> {
    let pending = this.files.get(path);
    if (!pending) {
      if (path === this.deps.path) pending = Promise.resolve({ lines: this.deps.lines, outline: this.deps.outline });
      else
        pending = Promise.all([this.deps.readFiles([path]), this.deps.outlineOf(path).catch(() => [])]).then(
          ([files, outline]) => ({ lines: files.get(path) ?? null, outline }),
        );
      this.files.set(path, pending);
    }
    return pending;
  }

  /** The members `cls` declares, with the lines of its file; null when either cannot be read. */
  classMembers(cls: ClassInheritance): Promise<Members | null> {
    const key = declarationKey(cls);
    let pending = this.members.get(key);
    if (!pending) {
      pending = (async () => {
        const file = await this.file(cls.path);
        const item = file.outline ? outlineClass(file.outline, cls) : null;
        return item && file.lines ? { lines: file.lines, all: item.children, methods: methodsOf(item) } : null;
      })();
      this.members.set(key, pending);
    }
    return pending;
  }

  /** The declarations `cls` writes as bases, and whether one of the names is not in the graph. */
  baseDeclarations(cls: ClassInheritance): Promise<{ decls: ClassInheritance[]; unresolved: boolean }> {
    const key = declarationKey(cls);
    let pending = this.bases.get(key);
    if (!pending) {
      pending = (async () => {
        const decls: ClassInheritance[] = [];
        let unresolved = false;
        for (const base of new Set(cls.bases)) {
          const found = await this.deps.index.resolve(base, cls.path);
          if (!found.length) unresolved = true;
          else decls.push(...found);
        }
        return { decls, unresolved };
      })();
      this.bases.set(key, pending);
    }
    return pending;
  }

  /**
   * Every ancestor of `cls` nearest first, not descending past a class the caller
   * stops at (its own bases cannot override a method it declares). `complete` is
   * false when a class walked through writes a base the graph does not know: an
   * unknown class may then be earlier in the MRO than any answer found.
   */
  async walk(cls: ClassInheritance, declares: (cls: ClassInheritance) => Promise<boolean>): Promise<Walk> {
    const seen = new Set<string>([declarationKey(cls)]);
    const decls: ClassInheritance[] = [];
    let complete = true;
    let level = [cls];
    for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
      const next: ClassInheritance[] = [];
      for (const parent of level) {
        const { decls: bases, unresolved } = await this.baseDeclarations(parent);
        if (unresolved) complete = false;
        for (const base of bases) {
          if (!seen.add(declarationKey(base))) continue;
          decls.push(base);
          if (!(await declares(base))) next.push(base);
        }
      }
      level = next;
    }
    return { decls, complete };
  }

  /** The method `name` a class in `walk`'s list declares, with its file's lines. */
  async methodOf(cls: ClassInheritance, name: string): Promise<{ members: Members; method: OutlineItem } | null> {
    const members = await this.classMembers(cls);
    const method = members?.methods.find((m) => baseName(m.name) === name);
    return members && method ? { members, method } : null;
  }

  /** Any member `name` a class in `walk`'s list declares (a field or property overrides too). */
  async memberOf(cls: ClassInheritance, name: string): Promise<{ members: Members; member: OutlineItem } | null> {
    const members = await this.classMembers(cls);
    const member = members?.all.find((m) => baseName(m.name) === name);
    return members && member ? { members, member } : null;
  }
}

interface Walk {
  decls: ClassInheritance[];
  complete: boolean;
}

// --- the inspections ---------------------------------------------------------

/**
 * 1. Circular inheritance: a class that ends up among its own ancestors. Python
 * raises `TypeError: Cannot create a consistent MRO` for it at import time.
 */
async function circularInheritance(view: ProjectView, facts: ClassFacts): Promise<Diagnostic[]> {
  const { decl } = facts;
  for (const base of (await view.baseDeclarations(decl)).decls) {
    if (declarationKey(base) === declarationKey(decl)) return [circular(facts)];
    for (const above of await ancestors(view.deps.index, base, MAX_DEPTH))
      if (declarationKey(above) === declarationKey(decl)) return [circular(facts)];
  }
  return [];
}

const circular = (facts: ClassFacts): Diagnostic =>
  problem(
    facts.item.selection_range,
    "error",
    PYTHON_CIRCULAR_BASES_PRODUCER,
    "circular-bases",
    tx`Circular inheritance: '${facts.decl.name}' inherits from itself`,
  );

/**
 * 2. `@override` consistency: only the direction that can be decided — a method
 * marked `@override` that no known base declares. A missing decorator is never
 * reported (it is optional, and older code cannot have it).
 */
async function overrideConsistency(view: ProjectView, facts: ClassFacts): Promise<Diagnostic[]> {
  const lines = view.deps.lines;
  const bindings = importBindings(lines);
  const out: Diagnostic[] = [];
  for (const method of facts.methods) {
    if (!decoratorsOf(lines, method).some((d) => isTypingOverride(d, bindings))) continue;
    const name = baseName(method.name);
    // `object` (every class's root) declares dunders itself.
    if (/^__\w+__$/.test(name)) continue;
    if ((await declaresIn(view, facts.decl, name)) !== "absent") continue;
    out.push(
      problem(
        method.selection_range,
        "warning",
        PYTHON_OVERRIDE_PRODUCER,
        "override",
        tx`Method '${name}' is marked @override but no base class declares it`,
      ),
    );
  }
  return out;
}

/** 3. Abstract methods a concrete class leaves unimplemented. */
async function missingAbstractMethods(view: ProjectView, facts: ClassFacts): Promise<Diagnostic[]> {
  // Any member of that name counts as implemented (a property or a field shadows
  // the abstract method too), and a class declaring an abstract method of its own
  // is abstract: Python lets it leave the inherited ones unimplemented.
  const own = new Map(facts.item.children.map((member) => [baseName(member.name), member]));
  if ([...own.values()].some((member) => isAbstractMethod(view.deps.lines, member))) return [];
  const candidates = new Set<string>();
  for (const decl of await ancestors(view.deps.index, facts.decl, MAX_DEPTH)) {
    const members = await view.classMembers(decl);
    if (!members) continue;
    for (const method of members.methods) {
      const name = baseName(method.name);
      if (own.has(name) || !isAbstractMethod(members.lines, method)) continue;
      candidates.add(name);
    }
  }
  const out: Diagnostic[] = [];
  for (const name of candidates) {
    if ((await abstractState(view, facts.decl, name)) !== "abstract") continue;
    out.push(
      problem(
        facts.item.selection_range,
        "warning",
        PYTHON_ABSTRACT_METHOD_PRODUCER,
        "abstract-method",
        tx`Class '${facts.decl.name}' does not implement abstract method '${name}'`,
      ),
    );
  }
  return out;
}

/**
 * 4. Redundant override: the body only repeats the inherited method. Only bodies
 * that provably behave the same without the override are reported — `pass` over a
 * method that does nothing, or `return super().m(same arguments)` with the same
 * signature. Anything else (decorators, a docstring, several statements) is left
 * alone.
 */
async function redundantOverrides(view: ProjectView, facts: ClassFacts): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  const lines = view.deps.lines;
  for (const method of facts.methods) {
    if (decoratorsOf(lines, method).length) continue;
    const name = baseName(method.name);
    const text = methodText(lines, method);
    if (!text.statements || text.statements.length !== 1) continue;
    const statement = text.statements[0]!;
    const empty = /^(?:pass|\.\.\.)$/.test(statement);
    const call = /^(return\s+)?super\(\)\.([A-Za-z_]\w*)\s*\((.*)\)$/.exec(statement);
    if (!empty && !call) continue;
    const base = await singleDeclaration(view, facts.decl, name);
    if (!base || isAbstractMethod(base.members.lines, base.method)) continue;
    if (empty) {
      const baseText = methodText(base.members.lines, base.method);
      if (!baseText.statements?.every((s) => /^(?:pass|\.\.\.)$/.test(s))) continue;
    } else if (!call || !sameCall(name, text, base.method, base.members.lines, call)) continue;
    out.push(
      problem(
        method.selection_range,
        "info",
        PYTHON_REDUNDANT_OVERRIDE_PRODUCER,
        "redundant-override",
        tx`Redundant override of '${name}'`,
      ),
    );
  }
  return out;
}

/**
 * The one base method `super()` of a `cls` instance reaches, when the whole
 * hierarchy is known and exactly one class declares it; null when that is not
 * certain (several declarations, or an unknown base anywhere before them).
 */
async function singleDeclaration(
  view: ProjectView,
  cls: ClassInheritance,
  name: string,
): Promise<{ members: Members; method: OutlineItem } | null> {
  const walk = await view.walk(cls, async (base) => (await view.memberOf(base, name)) !== null);
  if (!walk.complete) return null;
  const found: { members: Members; method: OutlineItem }[] = [];
  for (const decl of walk.decls) {
    const members = await view.classMembers(decl);
    // A class whose file cannot be read might declare it.
    if (!members) return null;
    // A field or property of that name is not the method `super()` calls.
    const method = members.methods.find((m) => baseName(m.name) === name);
    if (method) found.push({ members, method });
  }
  return found.length === 1 ? found[0]! : null;
}

/** Whether a base method repeats exactly what `super()` of the override would call. */
function sameCall(
  name: string,
  override: MethodText,
  base: OutlineItem,
  baseLines: readonly string[],
  call: RegExpExecArray,
): boolean {
  if (call[2] !== name) return false;
  if (decoratorsOf(baseLines, base).length) return false;
  const baseText = methodText(baseLines, base);
  if (!override.params || !baseText.params) return false;
  if (override.params.replace(/\s+/g, "") !== baseText.params.replace(/\s+/g, "")) return false;
  const names = parameterNames(override.params);
  const forwarded = splitTopLevel(call[3] ?? "").map((a) => a.trim());
  if (!names || names.length - 1 !== forwarded.length) return false;
  if (!names.slice(1).every((n, i) => n === forwarded[i])) return false;
  // A bare `super().m()` drops the value: only equivalent when the base returns none.
  if (!call[1]) return !baseText.statements || !returnsValue(baseText.statements);
  return true;
}

/** "declared" when a base declares `name`, "absent" when none does and the hierarchy is known, else "unknown". */
async function declaresIn(
  view: ProjectView,
  cls: ClassInheritance,
  name: string,
): Promise<"declared" | "absent" | "unknown"> {
  const walk = await view.walk(cls, async (base) => (await view.memberOf(base, name)) !== null);
  let found = false;
  for (const decl of walk.decls) {
    if (await view.memberOf(decl, name)) found = true;
    else if (!(await view.classMembers(decl))) return "unknown";
  }
  if (found) return "declared";
  return walk.complete ? "absent" : "unknown";
}

/**
 * What the ancestors of the class say about `name`: an abstract declaration with
 * no concrete one suppresses nothing, a concrete one (a method, property or field
 * of that name) means the class is fine, and an unknown base in the hierarchy
 * means neither can be told.
 */
async function abstractState(
  view: ProjectView,
  cls: ClassInheritance,
  name: string,
): Promise<"abstract" | "concrete" | "none" | "unknown"> {
  const walk = await view.walk(cls, async (base) => (await view.memberOf(base, name)) !== null);
  let concrete = false;
  let abstract = false;
  for (const decl of walk.decls) {
    const hit = await view.memberOf(decl, name);
    if (!hit) {
      if (!(await view.classMembers(decl))) return concrete ? "concrete" : "unknown";
      continue;
    }
    if (isAbstractMethod(hit.members.lines, hit.member)) abstract = true;
    else concrete = true;
  }
  if (concrete) return "concrete";
  if (!abstract) return walk.complete ? "none" : "unknown";
  return walk.complete ? "abstract" : "unknown";
}

// --- outline and source helpers ---------------------------------------------

const methodsOf = (item: OutlineItem): OutlineItem[] => item.children.filter((c) => METHOD_KINDS.has(c.kind));

/**
 * The class in `outline` that `decl` names: by exact position, else by a name the
 * document declares once (the graph is cached across edits, so the position may
 * have moved while the class itself is still the same one).
 */
function outlineClass(outline: readonly OutlineItem[], decl: ClassInheritance): OutlineItem | null {
  let named: OutlineItem | null = null;
  let namedCount = 0;
  const find = (items: readonly OutlineItem[]): OutlineItem | null => {
    for (const item of items) {
      if (item.kind === "class") {
        const start = item.selection_range.start;
        if (item.name === decl.name && start.line === decl.line && start.col === decl.col) return item;
        if (item.name === decl.name) {
          named = item;
          namedCount++;
        }
      }
      const deeper = find(item.children);
      if (deeper) return deeper;
    }
    return null;
  };
  return find(outline) ?? (namedCount === 1 ? named : null);
}

/** The base names the class header writes now, or null when the header cannot be read. */
function writtenBases(lines: readonly string[], item: OutlineItem): string[] | null {
  const start = item.selection_range.start;
  let tail = uncommented((lines[start.line] ?? "").slice(start.col + item.name.length));
  if (!tail.includes("(")) return [];
  let depth = bracketDelta(tail);
  for (let n = start.line + 1; depth > 0; n++) {
    if (n >= lines.length || n > start.line + 32) return null;
    const more = uncommented((lines[n] ?? "").trim());
    tail += ` ${more}`;
    depth += bracketDelta(more);
  }
  const open = tail.indexOf("(");
  const close = closingBracket(tail, open);
  if (close < 0) return null;
  const out: string[] = [];
  for (const part of splitTopLevel(tail.slice(open + 1, close))) {
    const base = writtenBase(part.trim());
    if (base) out.push(base);
  }
  return out;
}

/** One base argument as the graph stores it (bare name, last segment of a qualified one). */
function writtenBase(part: string): string | null {
  if (!part || part.includes("=")) return null; // metaclass=Meta and other keywords
  const bracket = part.indexOf("[");
  const value = (bracket < 0 ? part : part.slice(0, bracket)).trim();
  if (!/^[\w.]+$/.test(value)) return null; // *bases, calls and other expressions
  return value.split(".").pop() ?? null;
}

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, i) => name === b[i]);

/** The decorator expressions written above `item`, with `@` and arguments dropped from the names. */
function decoratorsOf(lines: readonly string[], item: OutlineItem): string[] {
  const defLine = item.selection_range.start.line;
  const from = Math.min(item.range.start.line, defLine);
  const out: string[] = [];
  if (from < defLine) {
    // A server's symbol range starts at the first decorator.
    for (let n = from; n < defLine; n++) {
      const text = uncommented(lines[n] ?? "").trim();
      if (text.startsWith("@")) out.push(text);
    }
    return out;
  }
  for (let n = defLine - 1; n >= 0; n--) {
    const text = uncommented(lines[n] ?? "").trim();
    if (!text.startsWith("@")) break;
    out.unshift(text);
  }
  return out;
}

const decoratorName = (decorator: string) => decorator.replace(/^@/, "").split("(")[0]!.trim();

const isAbstractMethod = (lines: readonly string[], item: OutlineItem) =>
  decoratorsOf(lines, item).some((d) => /(?:^|\.)(?:abstractmethod|abstractproperty)$/.test(decoratorName(d)));

/** `@override` of `typing` / `typing_extensions`, including an import alias. */
function isTypingOverride(decorator: string, bindings: ReadonlyMap<string, ImportBinding>): boolean {
  const name = decoratorName(decorator);
  if (name === "typing.override" || name === "typing_extensions.override") return true;
  if (name.includes(".")) return false;
  const binding = bindings.get(name);
  if (binding) return binding.name === "override" && /(?:^|\.)typing(?:_extensions)?$/.test(binding.module);
  // `from typing import *` is not read: a bare @override is Python 3.12's own.
  return name === "override";
}

interface MethodText {
  /** The `(params)` text of the signature; null when it cannot be read. */
  params: string | null;
  /** Body statements, blank and comment lines dropped; null when the body cannot be read. */
  statements: string[] | null;
}

/** The signature and body lines of a method, read from the document. */
function methodText(lines: readonly string[], item: OutlineItem): MethodText {
  const defLine = item.selection_range.start.line;
  let opened = false;
  let depth = 0;
  let params = "";
  let colonLine = -1;
  let colonCol = -1;
  // A quote inside the signature (a string default) can hide a bracket, and this
  // scan is a bracket counter rather than a lexer: give up instead of guessing.
  let quoted = false;
  for (let n = defLine; n < lines.length && colonLine < 0; n++) {
    const text = uncommented(lines[n] ?? "");
    if (text.includes('"') || text.includes("'")) quoted = true;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (!opened) {
        if (ch === "(") {
          opened = true;
          depth = 1;
        }
        continue;
      }
      if (depth === 0) {
        if (ch === ":") {
          colonLine = n;
          colonCol = i;
          break;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        params += ch;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth > 0) params += ch;
      } else params += ch;
    }
    if (n === lines.length - 1) break;
    params += " ";
  }
  if (colonLine < 0 || quoted) return { params: null, statements: null };
  const statements: string[] = [];
  const after = uncommented(lines[colonLine] ?? "")
    .slice(colonCol + 1)
    .trim();
  if (after) statements.push(after);
  else {
    const end = Math.max(colonLine, item.range.end.line);
    for (let n = colonLine + 1; n <= end; n++) {
      const line = uncommented(lines[n] ?? "").trim();
      if (line) statements.push(line);
    }
  }
  return { params: params.trim() || null, statements };
}

/** Parameter names of a signature; null for forms whose forwarding cannot be checked without guessing. */
function parameterNames(params: string): string[] | null {
  if (params.includes("*")) return null; // *args, **kwargs, keyword-only
  const names: string[] = [];
  for (const part of splitTopLevel(params)) {
    const text = part.trim();
    if (!text || text === "/") continue;
    const name = text.split(/[:=]/)[0]!.trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    names.push(name);
  }
  return names.length ? names : null;
}

/** Whether a body can return a value (so dropping a bare `super()` call would not be equivalent). */
function returnsValue(statements: readonly string[]): boolean {
  return statements.some((s) => {
    if (/^yield\b/.test(s)) return true;
    return /^return\b/.test(s) && s.replace(/^return\b/, "").trim() !== "";
  });
}

const problem = (range: Range, severity: Severity, producer: string, code: string, message: string): Diagnostic => ({
  range,
  severity,
  message,
  source: "Python",
  code,
  server: producer,
});

/** `text` without its trailing comment; quoted `#` stays. */
function uncommented(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return text.slice(0, i);
  }
  return text;
}

/** Net `([{` count of `text`. */
function bracketDelta(text: string): number {
  let depth = 0;
  for (const ch of text) if (ch === "(" || ch === "[" || ch === "{") depth++;
  const closed = text.match(/[)\]}]/g)?.length ?? 0;
  return depth - closed;
}

/** The index of the bracket closing the one at `open` in `text`. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `text` split at top-level commas (brackets stay together). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// --- the editor plugin -------------------------------------------------------

/** The project's classes may have changed: the next run reads the graph again. */
function invalidateGraph() {
  forgetInheritanceGraph();
}

const refreshables = new Set<() => void>();
let watching = false;

/** Python files are the only ones that change this inheritance graph. */
const isPythonFile = (path: string) => path.endsWith(".py") || path.endsWith(".pyi");

/** One subscription for the window, kept across editor remounts. */
function watchChanges() {
  if (watching) return;
  watching = true;
  onIdeEvent("fsChanged", (e) => {
    if (![...e.created, ...e.modified, ...e.removed].some(isPythonFile)) return;
    invalidateGraph();
    for (const refresh of refreshables) refresh();
  });
  onServerSettled(() => {
    invalidateGraph();
    for (const refresh of refreshables) refresh();
  });
}

/** Whether any of the four inspections is on in the profile in effect. */
function inspectionsEnabled(): boolean {
  const profile = inspectionProfile();
  return PRODUCERS.some(
    (producer) => profile[producerInspectionId(producer)]?.enabled ?? enabledByDefault(producerInspectionId(producer)),
  );
}

const viewers = new Map<string, number>();

const hasClass = (items: readonly OutlineItem[]): boolean =>
  items.some((item) => item.kind === "class" || hasClass(item.children));

/** Runs the inspections on Python documents and publishes them as local diagnostics. */
export function pythonInheritanceExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== "python" || ctx.virtual || ctx.doc < 0) return [];
  watchChanges();
  return ViewPlugin.define((view: EditorView) => {
    if (!isTauri()) return {};
    viewers.set(ctx.path, (viewers.get(ctx.path) ?? 0) + 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let disposed = false;
    const clear = () => {
      for (const producer of PRODUCERS) setFileDiagnostics(ctx.path, producer, []);
    };
    const publish = (diagnostics: readonly Diagnostic[]) => {
      const byProducer = new Map<string, Diagnostic[]>(PRODUCERS.map((p) => [p, []]));
      for (const d of diagnostics) byProducer.get(d.server ?? "")?.push(d);
      for (const producer of PRODUCERS) setFileDiagnostics(ctx.path, producer, byProducer.get(producer)!);
    };
    const run = async () => {
      const mine = ++sequence;
      const text = view.state.doc;
      try {
        const outline = await lspRequest(() => commands.docOutline(ctx.doc));
        // Every rule is about a class: no class, nothing to fetch the graph for.
        if (!hasClass(outline)) return;
        const { index } = await projectPythonIndex();
        const diagnostics = await inheritanceDiagnostics({
          path: ctx.path,
          lines: text.toJSON(),
          outline,
          index,
          readFiles: readManyFileLines,
          outlineOf: (path) => withDocument(path, (doc) => lspRequest(() => commands.docOutline(doc))),
        });
        if (disposed || mine !== sequence || view.state.doc !== text) return;
        publish(diagnostics);
      } catch (e) {
        if (!isCancelled(e)) console.debug("[inheritanceInspections]", e);
      }
    };
    const schedule = () => {
      clear();
      sequence++;
      clearTimeout(timer);
      timer = setTimeout(() => void run(), DEBOUNCE_MS);
    };
    const refresh = () => schedule();
    refreshables.add(refresh);
    schedule();
    const offProfile = subscribeInspectionProfile(() => {
      if (inspectionsEnabled()) schedule();
      else {
        clearTimeout(timer);
        clear();
      }
    });
    const offProject = useProject.subscribe((state, prev) => {
      if (state.project?.root === prev.project?.root) return;
      disposed = true;
      clearTimeout(timer);
      clear();
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        disposed = true;
        sequence++;
        clearTimeout(timer);
        offProfile();
        offProject();
        refreshables.delete(refresh);
        const remaining = (viewers.get(ctx.path) ?? 1) - 1;
        if (remaining) viewers.set(ctx.path, remaining);
        else {
          viewers.delete(ctx.path);
          clear();
        }
      },
    };
  });
}
