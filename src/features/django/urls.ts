/**
 * URL names in Python code: in `reverse("shop:product")` (and `reverse_lazy`, `redirect`,
 * `resolve_url`) the name completes from the project's `urls.py` files and Go to Declaration
 * opens its `path(..., name=...)` entry.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import type { NavigationMatch } from "@/editor/navigationProviders";
import { call, commands, type Range } from "@/platform/ipc";
import { useProject } from "@/platform/project";

export interface UrlName {
  /** With the module's `app_name` namespace: `shop:product`. */
  name: string;
  path: string;
  /** The name inside its quotes (0-based line, UTF-16 column). */
  range: Range;
}

const CALL = /\b(?:reverse|reverse_lazy|redirect|resolve_url)\(\s*$/;

/** The URL names a urls.py defines: `name="…"` arguments, under the module's `app_name`. */
export function urlNames(path: string, text: string): UrlName[] {
  const app = /^app_name\s*=\s*["']([^"'\n]+)["']/m.exec(text)?.[1];
  return [...text.matchAll(/\bname\s*=\s*(["'])([^"'\n]+)\1/g)].map((m) => {
    const from = m.index + m[0].length - m[2]!.length - 1;
    const line = text.slice(0, from).split("\n").length - 1;
    const col = from - text.lastIndexOf("\n", from - 1) - 1;
    return {
      name: app ? `${app}:${m[2]}` : m[2]!,
      path,
      range: { start: { line, col }, end: { line, col: col + m[2]!.length } },
    };
  });
}

/** The URL name string under `offset`, when it is the first argument of `reverse(` and the like. */
export function urlNameAt(text: string, offset: number): { name: string; from: number; to: number } | null {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  const line = text.slice(start, end < 0 ? text.length : end);
  for (const m of line.matchAll(/(["'])([\w:.-]*)\1/g)) {
    const from = start + m.index + 1;
    const to = from + m[2]!.length;
    if (offset >= from && offset <= to && CALL.test(line.slice(0, m.index))) return { name: m[2]!, from, to };
  }
  return null;
}

let cache: Promise<UrlName[]> | null = null;

/** Every URL name of the project's own urls.py files (read once, until one changes). */
export function projectUrlNames(): Promise<UrlName[]> {
  cache ??= (async () => {
    const paths = (await call(commands.findFilesNamed("urls.py")))
      .map(String)
      .filter((p) => !/\/(?:site-packages|node_modules|\.venv|venv)\//.test(p));
    const texts = await Promise.all(paths.map((p) => call(commands.fsReadText(p)).catch(() => "")));
    return paths.flatMap((p, i) => urlNames(p, texts[i]!));
  })().catch(() => []);
  return cache;
}

export const forgetUrlNames = () => void (cache = null);

/** `line`: the text of the line at `offset`, which starts at `lineFrom`. */
export async function urlNavigation(line: string, lineFrom: number, offset: number): Promise<NavigationMatch | null> {
  const at = urlNameAt(line, offset - lineFrom);
  if (!at?.name) return null;
  const names = (await projectUrlNames()).filter((u) => u.name === at.name);
  if (!names.length) return null;
  const targets = names.map(({ path, range, name }) => ({ path, range, name }));
  return { from: lineFrom + at.from, to: lineFrom + at.to, targets };
}

function where(path: string): string {
  const root = useProject.getState().project?.root;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

async function completion(ctx: CompletionContext): Promise<CompletionResult | null> {
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
    ? EditorState.languageData.of(() => [{ openideaCompletion: completion }])
    : [];
}
