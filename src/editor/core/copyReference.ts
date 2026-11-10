/**
 * Edit › Copy Reference (⌥⇧⌘C): with the caret on a declaration's name, its
 * fully qualified name, built from the file's outline and the language's module
 * conventions; anywhere else `path:line`, as in IDEA.
 */
import { writeClipboardText } from "@/platform/clipboard";

export interface ReferenceInput {
  /** Backend language id (`java`, `rust`…). */
  language: string;
  path: string;
  /** Project root, for project-relative paths and module names. */
  root: string | null;
  text: string;
  /** Names of the outline symbols down to the one named at the caret, outermost first; empty off a name. */
  chain: string[];
  /** 0-based caret line. */
  line: number;
}

export function copyReferenceToClipboard(reference: Promise<string>): Promise<void> {
  return reference.then(writeClipboardText);
}

/** Position inside a selected identifier or the identifier under the caret. */
export function referenceOffset(text: string, from: number, to: number): number | null {
  if (from !== to) return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(text.slice(from, to)) ? from : null;
  return /[\p{L}\p{N}_$]/u.test(text[from] ?? "") ? from : null;
}

export function relativePath(path: string, root: string | null): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

const stem = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** `impl Display for Foo<T>` → `Foo`; generic arguments dropped. */
export function rustImplType(name: string): string {
  const m = /^impl(?:<[^>]*>)?\s+(?:.*?\s+for\s+)?(.+)$/.exec(name);
  const type = (m ? m[1]! : name).trim();
  return type.replace(/<.*$/, "").replace(/^&(mut\s+)?/, "");
}

/** `crate::a::b` for `src/a/b.rs` (or `src/a/b/mod.rs`); `crate` for lib.rs / main.rs. */
export function rustModulePath(path: string): string {
  const src = path.lastIndexOf("/src/");
  const rel = src >= 0 ? path.slice(src + 5) : path.slice(path.lastIndexOf("/") + 1);
  const parts = rel.replace(/\.rs$/, "").split("/");
  const last = parts[parts.length - 1];
  if (last === "mod" || ((last === "lib" || last === "main") && parts.length === 1)) parts.pop();
  return ["crate", ...parts].join("::");
}

/** Dotted Python module path relative to the project (a leading `src/` dropped, `__init__` folded). */
export function pythonModulePath(path: string, root: string | null): string {
  const parts = relativePath(path, root)
    .replace(/\.pyi?$/, "")
    .split("/");
  const src = parts.lastIndexOf("src");
  if (src >= 0 && src < parts.length - 1) parts.splice(0, src + 1);
  if (parts[parts.length - 1] === "__init__") parts.pop();
  return parts.join(".");
}

const declared = (text: string, re: RegExp) => re.exec(text)?.[1] ?? null;

/** `method(int, String)` → `method`: a language server may bake the signature into a callable's name; IDEA's reference is the bare name. */
export function declaredName(item: { name: string; kind: string }): string {
  const n = item.name;
  if (!["function", "method", "constructor"].includes(item.kind)) return n;
  const paren = n.indexOf("(");
  return paren > 0 ? n.slice(0, paren).trim() : n;
}

/** `pkg.Outer.Inner#member` (the last symbol is the member unless the caret is on a type's name), as IDEA's Copy Reference. */
function jvmReference(pkg: string | null, chain: string[]): string {
  const [type, ...rest] = chain;
  const typePath = [pkg, type].filter(Boolean).join(".");
  return rest.length ? `${[typePath, ...rest.slice(0, -1)].join(".")}#${rest[rest.length - 1]}` : typePath;
}

export function qualifiedReference(r: ReferenceInput): string {
  const fallback = `${relativePath(r.path, r.root)}:${r.line + 1}`;
  const chain = r.chain.filter(Boolean);
  if (!chain.length) return fallback;
  switch (r.language) {
    case "java":
    case "groovy":
      return jvmReference(declared(r.text, /^\s*package\s+([\w.]+)\s*;?/m), chain);
    case "kotlin":
    case "scala":
      return jvmReference(declared(r.text, /^\s*package\s+([\w.]+)/m), chain);
    case "csharp":
      return chain.join(".");
    case "rust":
      return [rustModulePath(r.path), ...chain.map((n) => (n.startsWith("impl") ? rustImplType(n) : n))].join("::");
    case "python":
      return [pythonModulePath(r.path, r.root), ...chain].join(".");
    case "go": {
      const pkg = declared(r.text, /^\s*package\s+(\w+)/m) ?? stem(r.path);
      return [pkg, ...chain].join(".");
    }
    case "cpp":
    case "c":
    case "objective-cpp":
    case "php":
      return chain.join("::");
    default:
      return `${relativePath(r.path, r.root)}:${chain.join(".")}`;
  }
}
