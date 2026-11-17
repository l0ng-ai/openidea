/**
 * Navigate › Declaration (⌘-click, ⌘B) on `{{name}}` in a `.http` file: the `@name = …` line of
 * the same file, then the key `name` in each environment of the nearest
 * `http-client.private.env.json` and `http-client.env.json` — the variable lookup order.
 */
import type { Text } from "@codemirror/state";
import { docOf } from "@/editor/lsp/lsp";
import { registerNavigationProvider } from "@/editor/navigationProviders";
import { call, commands, type Location } from "@/platform/ipc";
import { HTTP_LANGUAGE } from "./editor";

/** The `{{name}}` reference whose name covers document `offset`, as document offsets. */
export function variableAt(doc: Text, offset: number): { name: string; from: number; to: number } | null {
  const line = doc.lineAt(offset);
  for (const m of line.text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
    const name = m[1]!;
    const from = line.from + m.index + m[0].indexOf(name, 2);
    const to = from + name.length;
    // Dynamic variables (`$uuid`, `$random.integer`…) have no definition.
    if (offset >= from && offset < to) return name.startsWith("$") ? null : { name, from, to };
  }
  return null;
}

/** `@name = value` lines of the request file defining `name`. */
export function fileVariableDefinitions(doc: Text, path: string, name: string): Location[] {
  const out: Location[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    const m = /^(\s*@)([^\s=]+)\s*=/.exec(text);
    if (m?.[2] !== name) continue;
    const col = m[1]!.length;
    out.push({ path, range: { start: { line: n - 1, col }, end: { line: n - 1, col: col + name.length } } });
  }
  return out;
}

export function registerVariableNavigation(): () => void {
  return registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || doc.language !== HTTP_LANGUAGE) return null;
    const text = view.state.doc;
    const at = variableAt(text, offset);
    if (!at) return null;
    const inFile = fileVariableDefinitions(text, doc.path, at.name);
    let inEnv: Location[] = [];
    try {
      inEnv = await call(commands.httpVariableDefinitions(doc.path, at.name));
    } catch {
      // No project or unreadable environment files: the file's own definitions still count.
    }
    return { from: at.from, to: at.to, targets: [...inFile, ...inEnv] };
  });
}
