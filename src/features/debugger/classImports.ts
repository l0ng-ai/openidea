/**
 * Java Evaluate with classes the frame's file does not import, as IDEA's Evaluate does with
 * the imports of its code fragment. java-debug takes only the expression's text, resolved
 * against the frame's compilation unit, so a class it reports as unresolved is looked up by
 * name and written fully qualified; the field keeps the short name.
 */
import type { DebugCompletion } from "@/bindings";
import { call, commands, nextRequestId, type DebugSessionId, type SymbolKind, type Variable } from "@/platform/ipc";
import { isVirtualUri } from "@/platform/virtualDocs";

const TYPE_KINDS = new Set<SymbolKind>(["class", "interface", "enum"]);
const MAX_ROUNDS = 3;

/** More than one class has the name: the user picks one ({@link rememberImport}). */
export class AmbiguousClassError extends Error {
  constructor(
    readonly className: string,
    readonly candidates: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

/** Per session: simple name → qualified name, like the imports of IDEA's code fragment. */
const imports = new Map<DebugSessionId, Map<string, string>>();

function importsOf(sessionId: DebugSessionId): Map<string, string> {
  let map = imports.get(sessionId);
  if (!map) imports.set(sessionId, (map = new Map()));
  return map;
}

/** Evaluations in `sessionId` write `qualifiedName`'s simple name qualified. */
export function rememberImport(sessionId: DebugSessionId, qualifiedName: string) {
  importsOf(sessionId).set(qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1), qualifiedName);
}

export function forgetImports(sessionId: DebugSessionId) {
  imports.delete(sessionId);
}

/** `expression` with the session's imports written qualified (see {@link qualify}). */
export function qualifyIn(sessionId: DebugSessionId, expression: string): string {
  const known = imports.get(sessionId);
  return known ? qualify(expression, known) : expression;
}

/**
 * A class completion java-debug inserts qualified (`com.x.Foo`) inserts the simple name and
 * imports the class, as IDEA's completion in the Evaluate field does.
 */
export function importingCompletion(sessionId: DebugSessionId, item: DebugCompletion): DebugCompletion {
  const text = item.text ?? item.label;
  if (item.kind === "method" || item.kind === "field" || !/^[a-z_$][\w$]*(\.[\w$]+)*\.[A-Z][\w$]*$/.test(text))
    return item;
  rememberImport(sessionId, text);
  return { ...item, text: text.slice(text.lastIndexOf(".") + 1) };
}

/** Type names a java-debug compile error could not resolve (`JSON cannot be resolved`, `… to a type`). */
export function unresolvedNames(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/\b([A-Z][\w$]*) cannot be resolved(?! to a variable)/g)) names.add(m[1]!);
  return [...names];
}

/**
 * `expression` with each name in `names` written qualified where it stands for a type: not
 * after `.` (a member), not before `(` unless after `new` (a method, not a constructor), not
 * in a string, char or comment.
 */
export function qualify(expression: string, names: ReadonlyMap<string, string>): string {
  if (!names.size) return expression;
  let out = "";
  let prev = "";
  let prevWord = "";
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const c = expression[i]!;
    let end = i + 1;
    if (expression.startsWith('"""', i)) {
      const close = expression.indexOf('"""', i + 3);
      end = close < 0 ? n : close + 3;
    } else if (c === '"' || c === "'") {
      while (end < n && expression[end] !== c) end += expression[end] === "\\" ? 2 : 1;
      end = Math.min(n, end + 1);
    } else if (expression.startsWith("//", i)) {
      const close = expression.indexOf("\n", i);
      end = close < 0 ? n : close;
    } else if (expression.startsWith("/*", i)) {
      const close = expression.indexOf("*/", i + 2);
      end = close < 0 ? n : close + 2;
    } else if (/[A-Za-z_$]/.test(c)) {
      while (end < n && /[\w$]/.test(expression[end]!)) end++;
      const name = expression.slice(i, end);
      const qualified = names.get(name);
      const next = expression.slice(end).match(/^\s*(\S?)/)![1];
      out += qualified && prev !== "." && (next !== "(" || prevWord === "new") ? qualified : name;
      prev = "a";
      prevWord = name;
      i = end;
      continue;
    }
    const token = expression.slice(i, end);
    out += token;
    if (token.trim()) {
      prev = token.length === 1 ? token : "a";
      prevWord = "";
    }
    i = end;
  }
  return out;
}

/** The package in a symbol's container; some servers put more before it (`app.jar com.x`). */
function packageOf(container: string | null): string {
  const last = (container ?? "").trim().split(/\s+/).pop() ?? "";
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(last) ? last : "";
}

/**
 * Whether `source` declares type `simple` so that other packages can't use it: `private`
 * (`java.util.Arrays.ArrayList`), or top-level without `public` (android-json's `org.json.JSON`).
 * A nested type without modifiers counts as visible: it is public inside an interface.
 * `false` when the declaration is not found.
 */
export function declaresInaccessible(source: string, simple: string, nested = false): boolean {
  const declaration = new RegExp(
    String.raw`^[ \t]*((?:@[\w.]+(?:\([^)]*\))?\s+|[a-z-]+\s+)*)(?:class|interface|enum|record|@interface)\s+${simple.replaceAll("$", "\\$")}\b`,
    "m",
  ).exec(source);
  if (!declaration) return false;
  const modifiers = declaration[1]!;
  return /\bprivate\b/.test(modifiers) || (!nested && !/\b(public|protected)\b/.test(modifiers));
}

async function sourceOf(path: string): Promise<string> {
  return isVirtualUri(path) ? (await call(commands.lspVirtualDocument(path))).text : call(commands.fsReadText(path));
}

/**
 * Qualified names of the classes called `simple` in the project and its dependencies that
 * other packages can use; IDEA's import offers only accessible classes too.
 */
export async function findClasses(simple: string): Promise<string[]> {
  const symbols = await call(commands.lspWorkspaceSymbols(nextRequestId(), simple));
  const found = new Map<string, string>();
  for (const s of symbols) {
    const pkg = s.name === simple && TYPE_KINDS.has(s.kind) ? packageOf(s.container) : "";
    if (pkg && !found.has(`${pkg}.${simple}`)) found.set(`${pkg}.${simple}`, s.location.path);
  }
  const names = [...found.keys()].sort();
  if (names.length < 2) return names;
  const hidden = await Promise.all(
    names.map((name) =>
      sourceOf(found.get(name)!).then(
        // Nested in a type: the container's last segment is a class name (`java.util.Map`).
        (source) => declaresInaccessible(source, simple, /(^|\.)[A-Z][\w$]*$/.test(name.slice(0, -simple.length - 1))),
        () => false,
      ),
    ),
  );
  return names.filter((_, i) => !hidden[i]);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `run(expression)` with the session's imports applied; a class the evaluation could not
 * resolve and only one class has the name of is imported and the evaluation repeated.
 * Throws {@link AmbiguousClassError} when several have it.
 */
export async function evaluateWithImports(
  sessionId: DebugSessionId,
  expression: string,
  run: (expression: string) => Promise<Variable>,
  find: (simple: string) => Promise<string[]> = findClasses,
): Promise<Variable> {
  const known = importsOf(sessionId);
  for (let round = 0; ; round++) {
    try {
      return await run(qualify(expression, known));
    } catch (e) {
      const names = unresolvedNames(messageOf(e)).filter((name) => !known.has(name));
      if (round >= MAX_ROUNDS || !names.length) throw e;
      let added = false;
      for (const name of names) {
        const candidates = await find(name).catch(() => []);
        if (candidates.length > 1) throw new AmbiguousClassError(name, candidates, messageOf(e));
        if (candidates.length === 1) {
          known.set(name, candidates[0]!);
          added = true;
        }
      }
      if (!added) throw e;
    }
  }
}
