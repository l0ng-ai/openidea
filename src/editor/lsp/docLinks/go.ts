/**
 * Go documentation links (gopls), resolved to declarations through `workspace/symbol`
 * so their documentation opens in place, as in GoLand:
 * - `https://pkg.go.dev/<import path>#<Name>` (or `#<Type>.<Method>`) links;
 * - type names in a signature: `pkg.Name` by the import the qualifier names, `Name` in the
 *   documented symbol's package, predeclared names (`string`, `error`…) in `builtin`.
 * Only a unique exact match counts: nothing is guessed from the name alone.
 */
import { Channel } from "@tauri-apps/api/core";
import { call, commands, nextRequestId, type LibraryGroup, type WorkspaceSymbol } from "@/platform/ipc";
import { symbols, unique, type DocTarget } from "./symbols";
import { dirname } from "@/platform/project";
import { readFileLines } from "../files";

/** A name in a Go signature: `pkg.Name` (`qualifier` = `pkg`) or `Name`. */
export interface GoRef {
  qualifier: string | null;
  name: string;
}

/** Where a signature comes from: its declaration's file and the file the documentation was asked in. */
export interface GoRefContext {
  declaring: string | null;
  current: string | null;
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** `https://pkg.go.dev/<import path>[@version]#<Name>` or `#<Type>.<Method>`; null for other links. */
export function pkgGoDevLink(href: string): { importPath: string; name: string } | null {
  // Malformed URLs and escapes are no links.
  try {
    const url = new URL(href);
    if (url.hostname !== "pkg.go.dev") return null;
    const name = decodeURIComponent(url.hash.slice(1));
    const importPath = decodeURIComponent(url.pathname.slice(1)).replace(/@[^/]*/, "");
    if (!importPath || !new RegExp(`^${IDENT}(\\.${IDENT})?$`).test(name)) return null;
    return { importPath, name };
  } catch {
    return null;
  }
}

/**
 * The package name an import path usually declares (`…/yaml.v3` → `yaml`, `…/go-cmp/v2` → `cmp`).
 * ponytail: a heuristic, used only to query and for packages no file at hand imports.
 */
export function goPackageName(importPath: string): string {
  const parts = importPath.split("/");
  let last = parts[parts.length - 1] ?? "";
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2]!;
  return last
    .replace(/\.v\d+$/, "")
    .replace(/^go-|-go$/, "")
    .replace(/\W/g, "_");
}

/** Import name → import path of a Go file's imports (aliases, groups; `_` and `.` imports skipped). */
export function goImports(text: string): Map<string, string> {
  const imports = new Map<string, string>();
  const spec = new RegExp(`^\\s*(?:(${IDENT}|\\.)\\s+)?"([^"]+)"`);
  for (const m of text.matchAll(/^import\s*(?:\(([\s\S]*?)\)|(.*))$/gm)) {
    for (const line of (m[1] ?? m[2] ?? "").split("\n")) {
      const s = spec.exec(line);
      if (!s || s[1] === "_" || s[1] === ".") continue;
      imports.set(s[1] ?? goPackageName(s[2]!), s[2]!);
    }
  }
  return imports;
}

/** The name at [from, to) of a signature's text, with the `pkg.` written before it. */
export function signatureRef(text: string, from: number, to: number): GoRef {
  const q = new RegExp(`(?:^|[^\\w.])(${IDENT})\\.$`).exec(text.slice(0, from));
  return { qualifier: q?.[1] ?? null, name: text.slice(from, to) };
}

const PREDECLARED = new Set(
  (
    "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune " +
    "string uint uint8 uint16 uint32 uint64 uintptr true false iota nil append cap clear close complex " +
    "copy delete imag len make max min new panic print println real recover"
  ).split(" "),
);

/** Whether `s` is `name` itself, as found by a query qualified with `qualifier` or not. */
function named(s: WorkspaceSymbol, qualifier: string, name: string): boolean {
  return s.name === name || s.name === `${qualifier}.${name}`;
}

/** `name` (`Name` or `Type.Method`) declared in the package at `importPath`. */
export async function findInPackage(importPath: string, name: string): Promise<DocTarget | null> {
  const pkg = goPackageName(importPath);
  const inPackage = (list: WorkspaceSymbol[]) => list.filter((s) => s.container === importPath && named(s, pkg, name));
  const hits = inPackage(await symbols(`${pkg}.${name}`));
  return unique(hits.length ? hits : inPackage(await symbols(name)));
}

async function importsOf(path: string | null): Promise<Map<string, string>> {
  const lines = path ? await readFileLines(path).catch(() => null) : null;
  return goImports(lines?.join("\n") ?? "");
}

async function goSourceRoot(): Promise<string | null> {
  const groups = await call(commands.sdkProjectLibraries(nextRequestId(), new Channel<LibraryGroup[]>())).catch(
    () => [],
  );
  return groups.find((g) => g.kind === "go")?.roots[0]?.path ?? null;
}

/** A predeclared name's declaration in `$GOROOT/src/builtin/builtin.go`. */
async function builtin(name: string): Promise<DocTarget | null> {
  const src = await goSourceRoot();
  if (!src) return null;
  const path = `${src}/builtin/builtin.go`;
  const lines = (await readFileLines(path).catch(() => null)) ?? [];
  const decl = new RegExp(`^(?:(?:type|func|var|const)\\s+|\\t)(${name})\\b`);
  for (let line = 0; line < lines.length; line++) {
    const m = decl.exec(lines[line]!);
    if (m) return { path, line, col: m[0].length - name.length };
  }
  return null;
}

/** Where a name in a Go signature is declared; null when it isn't found exactly once. */
export async function resolveGoRef(ref: GoRef, ctx: GoRefContext): Promise<DocTarget | null> {
  const { qualifier, name } = ref;
  if (!qualifier) {
    if (PREDECLARED.has(name)) return builtin(name);
    const file = ctx.declaring ?? ctx.current;
    if (!file) return null;
    const dir = dirname(file);
    return unique((await symbols(name)).filter((s) => s.name === name && dirname(s.location.path) === dir));
  }
  // A function's signature is qualified by the imports of the file asked about; a type's
  // declaration is its source text, qualified by the declaring file's imports.
  const files = [...new Set([ctx.declaring, ctx.current])];
  const paths = new Set((await Promise.all(files.map(importsOf))).map((m) => m.get(qualifier)).filter((p) => !!p));
  if (paths.size > 1) return null;
  const [path] = paths;
  if (path) return findInPackage(path, name);
  // A package neither file imports: gopls names it by its package name.
  return unique(
    (await symbols(`${qualifier}.${name}`)).filter(
      (s) => !!s.container && goPackageName(s.container) === qualifier && named(s, qualifier, name),
    ),
  );
}
