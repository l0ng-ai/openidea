/**
 * Find Usages without a language server (IDEA's dumb mode): a certain local's
 * same-scope references, otherwise the project index's occurrences of the name
 * (identifiers and component tags), else identifier occurrences across the
 * project (comments and strings excluded) — labelled as text occurrences.
 */
import type { Location, Range } from "@/bindings";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { editorsFor, whenSynced } from "@/editor/api";
import { structure } from "@/editor/structure";
import { filesMentioning } from "./candidates";
import type { CaretContext } from "./ipc";

export const LOCAL_NOTE = "Based on syntax (language server not ready)";
export const TEXT_NOTE = "Text occurrences (language server not ready)";
export const INDEX_NOTE = "Based on project index (language server not ready)";

export interface SyntaxUsages {
  locs: Location[];
  /** Shown with the results: where they came from and how far to trust them. */
  note: string;
}

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

function inside(range: Range, pos: Range["start"]) {
  const after = (a: Range["start"], b: Range["start"]) => a.line - b.line || a.col - b.col;
  return after(range.start, pos) <= 0 && after(pos, range.end) <= 0;
}

/** Null when the structure service cannot answer for this file (no grammar, no editor). */
export async function syntaxUsages(c: CaretContext): Promise<SyntaxUsages | null> {
  const language = c.view
    ? editorsFor(c.path).find((e) => e.view === c.view)?.ctx.language
    : editorsFor(c.path)[0]?.ctx.language;
  if (!language) return null;
  const support = await structure.support(language);
  if (!support.tree) return null;
  if (c.view) await whenSynced(c.view);
  const pos = { line: c.line, col: c.col };
  let name = c.word;
  if (support.locals) {
    const locals = await structure.locals(c.doc, pos);
    if (locals.status === "noIdentifier") return { locs: [], note: LOCAL_NOTE };
    if (locals.status === "local") {
      const { symbol } = locals;
      if (symbol.certain)
        return { locs: symbol.references.map((range) => ({ path: c.path, range })), note: LOCAL_NOTE };
      // Re-declared in the same scope: every plain occurrence in that scope, as text.
      const occ = await structure.identifiers(c.doc, symbol.name);
      return {
        locs: occ
          .filter((o) => !o.qualified && inside(symbol.scope, o.range.start))
          .map((o) => ({ path: c.path, range: o.range })),
        note: TEXT_NOTE,
      };
    }
    name = locals.name;
  }
  if (!name || !IDENT.test(name)) return null;
  // Non-local name: the project index first (identifiers + component tags),
  // then whole-word text search as the last resort when the index is empty.
  const indexed = await call(commands.indexUsages(name)).catch(() => null);
  if (indexed?.length) return { locs: indexed.map((l) => ({ path: l.path, range: l.range })), note: INDEX_NOTE };
  const { paths, limitHit } = await filesMentioning(nextRequestId(), name);
  if (!paths.includes(c.path)) paths.push(c.path);
  const files = await structure.identifiersInFiles(paths, name);
  const locs = files.flatMap((f) => f.occurrences.map((o) => ({ path: f.path, range: o.range })));
  return { locs, note: limitHit ? `${TEXT_NOTE} · search limit reached, results may be incomplete` : TEXT_NOTE };
}
