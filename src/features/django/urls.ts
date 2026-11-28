/**
 * URL names in Python code: in `reverse("shop:product")` (and `reverse_lazy`, `redirect`,
 * `resolve_url`) the name completes from the project's `urls.py` files and Go to Declaration
 * opens its `path(..., name=...)` entry.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import { invalidateNavigationProviders, type NavigationMatch } from "@/editor/navigationProviders";
import { call, commands, type Range } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { masks, position, pyCalls, pyString } from "./pyscan";

export interface UrlName {
  /** With its namespaces: `shop:product`, `shop:api:item`. */
  name: string;
  path: string;
  /** The name inside its quotes (0-based line, UTF-16 column). */
  range: Range;
}

/** What a urls.py says: its `app_name`, its named patterns and the URL modules it includes. */
export interface UrlModule {
  path: string;
  app: string | null;
  names: Array<{ name: string; range: Range }>;
  /** `include("x.urls", namespace=…)`, `include(("x.urls", "app"))`. */
  includes: Array<{ module: string; namespace: string | null; app: string | null }>;
}

const CALL = /\b(?:reverse|reverse_lazy|redirect|resolve_url)\(\s*$/;

export function parseUrls(path: string, text: string): UrlModule {
  const { code } = masks(text);
  const app = /^app_name\s*=\s*["']([^"'\n]+)["']/m.exec(code)?.[1] ?? null;
  const names: UrlModule["names"] = [];
  const includes: UrlModule["includes"] = [];
  for (const c of pyCalls(text, ["path", "re_path", "url", "include"])) {
    const kw = (key: string) => c.args.find((a) => a.key === key);
    if (c.name === "include") {
      const first = c.args[0];
      const tuple = first && !first.key && /^\(\s*(.+?)\s*,\s*(.+?)\s*,?\s*\)$/s.exec(first.value);
      const module = first && !first.key && pyString(tuple ? tuple[1]! : first.value);
      const ns = kw("namespace");
      if (module)
        includes.push({ module, namespace: ns ? pyString(ns.value) : null, app: tuple ? pyString(tuple[2]!) : null });
      continue;
    }
    const arg = kw("name");
    const name = arg && pyString(arg.value);
    if (!arg || !name) continue;
    const from = arg.from + arg.value.indexOf(name);
    const start = position(text, from);
    names.push({ name, range: { start, end: { line: start.line, col: start.col + name.length } } });
  }
  return { path, app, names, includes };
}

/**
 * Full URL names: a module's names under the namespaces of the includes that reach it, nested
 * (`shop:api:item`). An include's namespace is its instance namespace (`namespace=`) or the
 * application namespace (the tuple's, else the included module's `app_name`); `reverse` takes
 * either. A module no other one includes keeps its own `app_name`.
 */
export function resolveUrlNames(modules: readonly UrlModule[]): UrlName[] {
  const byModule = (dotted: string) => {
    const tail = `/${dotted.replace(/\./g, "/")}.py`;
    return modules.find((m) => m.path.endsWith(tail)) ?? null;
  };
  const parents = new Map<UrlModule, Array<{ from: UrlModule; spaces: string[] }>>();
  for (const m of modules)
    for (const inc of m.includes) {
      const target = byModule(inc.module);
      if (!target) continue;
      const app = inc.app ?? target.app;
      const spaces = [...new Set([inc.namespace ?? app, app].filter((x): x is string => !!x))];
      parents.set(target, [...(parents.get(target) ?? []), { from: m, spaces }]);
    }
  const chains = (m: UrlModule, seen: Set<UrlModule>): string[][] => {
    const up = parents.get(m);
    if (!up) return [m.app ? [m.app] : []];
    if (seen.has(m)) return [];
    const next = new Set(seen).add(m);
    return up
      .flatMap(({ from, spaces }) =>
        chains(from, next).flatMap((c) => (spaces.length ? spaces.map((s) => [...c, s]) : [c])),
      )
      .slice(0, 20);
  };
  const out = new Map<string, UrlName>();
  for (const m of modules)
    for (const chain of chains(m, new Set()))
      for (const { name, range } of m.names) {
        const full = [...chain, name].join(":");
        out.set(`${full}\0${m.path}\0${range.start.line}`, { name: full, path: m.path, range });
      }
  return [...out.values()];
}

/**
 * The URL name string under `offset`, when it is the first argument of `reverse(` and the like
 * (the call may start on an earlier line of `text`).
 */
export function urlNameAt(text: string, offset: number): { name: string; from: number; to: number } | null {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  const line = text.slice(start, end < 0 ? text.length : end);
  for (const m of line.matchAll(/(["'])([\w:.-]*)\1/g)) {
    const from = start + m.index + 1;
    const to = from + m[2]!.length;
    if (offset >= from && offset <= to && CALL.test(text.slice(Math.max(0, from - 201), from - 1)))
      return { name: m[2]!, from, to };
  }
  return null;
}

let cache: Promise<UrlName[]> | null = null;

/** Every URL name of the project's own urls.py files (read once, until one changes or indexing ends). */
export function projectUrlNames(): Promise<UrlName[]> {
  const read = (cache ??= (async () => {
    const paths = (await call(commands.findFilesNamed("urls.py")))
      .map(String)
      .filter((p) => !/\/(?:site-packages|node_modules|\.venv|venv)\//.test(p));
    const texts = await Promise.all(paths.map((p) => call(commands.fsReadText(p)).catch(() => "")));
    return resolveUrlNames(paths.map((p, i) => parseUrls(p, texts[i]!)));
  })().catch(() => []));
  // Nothing found (the index may still be building): ask again next time.
  void read.then((names) => !names.length && cache === read && (cache = null));
  return read;
}

/** Drops the names read, and what navigation remembers of them. */
export function forgetUrlNames() {
  cache = null;
  invalidateNavigationProviders();
}

/** `text`: the document from `base` on, around `offset` (with the lines before it, for a call that starts there). */
export async function urlNavigation(text: string, base: number, offset: number): Promise<NavigationMatch | null> {
  const at = urlNameAt(text, offset - base);
  if (!at?.name) return null;
  const names = (await projectUrlNames()).filter((u) => u.name === at.name);
  if (!names.length) return null;
  const targets = names.map(({ path, range, name }) => ({ path, range, name }));
  return { from: base + at.from, to: base + at.to, targets };
}

function where(path: string): string {
  const root = useProject.getState().project?.root;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export async function urlCompletion(ctx: CompletionContext): Promise<CompletionResult | null> {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 200), ctx.pos);
  const m = /(["'])([\w:.-]*)$/.exec(before);
  if (!m || !CALL.test(before.slice(0, m.index))) return null;
  const names = await projectUrlNames();
  if (ctx.aborted || !names.length) return null;
  return {
    from: ctx.pos - m[2]!.length,
    validFor: /^[\w:.-]*$/,
    // Above what the language server offers in the string (parameter names).
    options: names.map((u) => ({ label: u.name, type: "constant", typeText: where(u.path), boost: 50 })),
  };
}

export function urlCompletionExtension(doc: EditorDocContext): Extension {
  return doc.language === "python" && !doc.virtual && !doc.readOnly
    ? EditorState.languageData.of(() => [{ openideaCompletion: urlCompletion }])
    : [];
}
