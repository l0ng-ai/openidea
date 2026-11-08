/**
 * SQL completion inside PHP's SQL strings (`editor/core/cm/phpSql.ts` finds
 * them): the console's context-aware candidates against the schema of the
 * data source the file is bound to, else the first connected one, else the
 * only one; keywords and functions when there is none.
 */
import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { snippet } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import { sqlStringAt, sqlText, type SqlString } from "@/editor/core/cm/phpSql";
import type { DbCompletion, DbDriver } from "@/platform/ipc";
import { docNode, iconOf } from "./console";
import { analyze } from "./sql/analyze";
import { shouldAutoCompleteSql, sqlCandidates, type SqlCandidate } from "./sql/complete";
import { consoleSource, loadCompletion, loadSources, sourceById, useDatabase } from "./store";

const PHP_LANGUAGE = "php";

/** The data source SQL in `path`'s strings completes against. */
export function phpSqlSource(path: string): string | null {
  const s = useDatabase.getState();
  if (s.consoles[path]) {
    const bound = consoleSource(path);
    if (bound) return bound;
  }
  const [connected] = [...s.connected].sort();
  return connected ?? consoleSource(path);
}

/** `text` as it has to be written inside the PHP string (quotes and backslashes escaped). */
export function escapeForPhp(text: string, quote: SqlString["quote"]): string {
  if (!quote) return text;
  if (quote === "'") return text.replace(/[\\']/g, (c) => `\\${c}`);
  return text.replace(/[\\"$]/g, (c) => `\\${c}`);
}

export interface PhpSqlCompletion {
  from: number;
  candidates: SqlCandidate[];
  quote: SqlString["quote"];
}

/** Candidates at `pos` in a PHP document, or `null` outside SQL strings (or nothing to offer). */
export function phpSqlCandidates(
  state: EditorState,
  pos: number,
  explicit: boolean,
  model: DbCompletion | null,
  driver: DbDriver,
  sourceName?: string,
): PhpSqlCompletion | null {
  const s = sqlStringAt(state, pos);
  if (!s) return null;
  const text = sqlText(s, (from, to) => state.sliceDoc(from, to));
  const analysis = analyze(text, pos - s.from, driver);
  if (!explicit && !shouldAutoCompleteSql(analysis)) return null;
  const candidates = sqlCandidates({ model, analysis, driver, sourceName }).filter(
    // A snippet cannot be escaped for the string it lands in.
    (c) => !c.snippet || !s.quote || !c.snippet.includes(s.quote),
  );
  return candidates.length ? { from: s.from + analysis.prefix.from, candidates, quote: s.quote } : null;
}

function completionSource(path: string): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!sqlStringAt(ctx.state, ctx.pos)) return null;
    const state = useDatabase.getState();
    if (!state.loaded) void loadSources();
    const id = phpSqlSource(path);
    const source = sourceById(id);
    const driver: DbDriver = source?.driver ?? "mysql";
    const model = id ? (state.completion[id] ?? null) : null;
    if (id && !model) void loadCompletion(id);
    const result = phpSqlCandidates(ctx.state, ctx.pos, ctx.explicit, model, driver, source?.name ?? undefined);
    if (!result) return null;
    return {
      from: result.from,
      options: result.candidates.map((c) => ({
        label: c.label,
        detail: c.tail,
        typeText: c.type,
        icon: iconOf(c),
        type: c.kind === "keyword" ? "keyword" : c.kind,
        boost: Math.max(-99, Math.min(99, c.boost)),
        info: c.doc ? () => docNode(c.doc!) : undefined,
        apply: c.snippet ? snippet(c.snippet) : escapeForPhp(c.insert ?? c.label, result.quote),
      })),
      validFor: /^[\p{L}\p{N}_]*$/u,
    };
  };
}

/** Editor contribution: SQL completion in the SQL strings of PHP files. */
export function phpSqlExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== PHP_LANGUAGE || ctx.readOnly) return [];
  const source = completionSource(ctx.path);
  return EditorState.languageData.of((state, pos) => (sqlStringAt(state, pos) ? [{ openideaCompletion: source }] : []));
}
