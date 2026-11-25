/**
 * Where a file is used from other files (WebStorm's Find Usages on a file): the imports of it
 * (vtsls' file references) and, for a Vue single-file component, the usages of the name each
 * import gives it — its template tags and script references (Show component usages).
 */
import { Channel } from "@tauri-apps/api/core";
import type { Location } from "@/bindings";
import { commands, nextRequestId } from "@/platform/ipc";
import { editorsFor } from "@/editor/api";
import { isUnavailable, lspRequest } from "@/editor/lsp/lsp";

/** Runs `fn` on `path`'s document and text: its open editor's, or one opened for the call. */
export async function withDocText<T>(path: string, fn: (doc: number, text: string) => Promise<T>): Promise<T> {
  const open = editorsFor(path)[0];
  if (open) return fn(open.ctx.doc, open.view.state.doc.toString());
  const info = await lspRequest(() => commands.docOpen(path));
  try {
    return await fn(info.id, info.text);
  } finally {
    void commands.docClose(info.id);
  }
}

/** The default import binding written before a module specifier: `import Name from` / `import Name, { … } from`. */
const DEFAULT_IMPORT = /\bimport\s+(?:type\s+)?([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"`]?$/u;

/**
 * The name `textBefore` (a line up to an import's module specifier, or into its quotes as
 * tsserver's ranges start) gives the default import, and its column.
 */
export function defaultImportName(textBefore: string): { name: string; col: number } | null {
  const m = DEFAULT_IMPORT.exec(textBefore);
  if (!m) return null;
  return { name: m[1]!, col: m.index + m[0].indexOf(m[1]!, "import".length) };
}

/** The imports of `path` in other files (`doc`: its document, when already open); null when no language server can tell. */
export async function fileImports(path: string, doc?: number): Promise<Location[] | null> {
  const search = (doc: number) => lspRequest(() => commands.lspFileReferences(nextRequestId(), doc));
  try {
    return await (doc === undefined ? withDocText(path, search) : search(doc));
  } catch (e) {
    if (isUnavailable(e)) return null;
    throw e;
  }
}

const key = (l: Location) => `${l.path}:${l.range.start.line}:${l.range.start.col}`;

/**
 * The usages of the file `path` in other files: its imports, and for a `.vue` component the
 * references to the name each default import binds (the component's tags in templates). Null
 * when no language server can tell. `doc`: `path`'s document, when already open.
 */
export async function fileReferenceUsages(
  path: string,
  signal?: AbortSignal,
  doc?: number,
): Promise<Location[] | null> {
  const imports = await fileImports(path, doc);
  if (!imports) return null;
  const found = new Map<string, Location>();
  for (const imp of imports) {
    if (imp.path === path) continue;
    found.set(key(imp), imp);
  }
  if (!path.endsWith(".vue")) return [...found.values()];
  const importLines = new Set(imports.map((l) => `${l.path}:${l.range.start.line}`));
  for (const imp of imports) {
    if (signal?.aborted || imp.path === path) break;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one importing file at a time
      await withDocText(imp.path, async (doc, text) => {
        const line = text.split("\n")[imp.range.start.line] ?? "";
        const binding = defaultImportName(line.slice(0, imp.range.start.col));
        if (!binding) return;
        const { locations } = await lspRequest(() =>
          commands.lspReferences(
            nextRequestId(),
            doc,
            { line: imp.range.start.line, col: binding.col },
            false,
            false,
            false,
            new Channel(),
          ),
        );
        // An import's own binding is on the import's line, already listed (the search follows the
        // component into the other files that import it, so check every import).
        for (const l of locations)
          if (l.path !== path && !importLines.has(`${l.path}:${l.range.start.line}`)) found.set(key(l), l);
      });
    } catch {
      // An importing file the server can't search keeps just its import.
    }
  }
  return [...found.values()];
}
