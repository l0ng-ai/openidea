/**
 * Language support of query consoles beyond completion, answered from the
 * data source's schema model without a language server: unresolved-name
 * inspections, Go to Declaration (aliases and CTEs in the text, tables and
 * columns in the Database tool window), Quick Documentation and Reformat Code.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import {
  CONTRIBUTED_DEFINITION,
  CONTRIBUTED_FORMAT,
  CONTRIBUTED_HOVER,
  offsetToPos,
  type ContributedDefinition,
  type ContributedFormatter,
  type ContributedHover,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { showHint } from "@/editor/lsp/hint";
import type { DbCompletion, DbCompletionTable } from "@/platform/ipc";
import { sqlDriverOf, type SqlDriver } from "./sql/dialect";
import { formatSql } from "./sql/format";
import { editorPrefs, sqlCaseStyle } from "@/platform/editorSettings";
import { SqlResolver, type SqlSymbol } from "./sql/resolve";
import { useProject } from "@/platform/project";
import { consoleSchema, consoleSource, duckdbCatalogTree, revealInTree, sourceById, useDatabase } from "./store";

/** Producer id of the console's diagnostics (Problems view, hover). */
const INSPECTIONS = "sql-inspections";
const INSPECT_DELAY = 400;

function sourceOf(path: string): { id: string | null; driver: SqlDriver; model: DbCompletion | null } {
  const id = consoleSource(path);
  const model = id ? (useDatabase.getState().completion[id] ?? null) : null;
  // Unqualified names resolve in the console's active schema (IDEA's schema dropdown).
  const schema = consoleSchema(path);
  return {
    id,
    driver: sqlDriverOf(sourceById(id)),
    model: model && schema ? { ...model, defaultSchema: schema } : model,
  };
}

/**
 * Where the SQL of a file is: its text as the SQL tools read it (the file's offsets), and
 * whether an offset is in SQL. A SQL file is SQL throughout; a MyBatis mapper only in its statements.
 */
export interface SqlText {
  text(state: EditorState): string;
  at?(state: EditorState, pos: number): boolean;
}

export const WHOLE_FILE: SqlText = { text: (state) => state.doc.toString() };

function resolver(path: string, state: EditorState, sql: SqlText): SqlResolver {
  const { driver, model } = sourceOf(path);
  return new SqlResolver(sql.text(state), driver, model);
}

/** Unresolved tables / columns / aliases as error diagnostics, re-checked after edits and schema loads. */
function inspections(path: string, sql: SqlText): Extension {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const doc = view.state.doc;
      const problems = sourceOf(path).model ? resolver(path, view.state, sql).problems() : [];
      setFileDiagnostics(
        path,
        INSPECTIONS,
        problems.map((p) => ({
          range: { start: offsetToPos(doc, p.from), end: offsetToPos(doc, p.to) },
          severity: "error",
          message: p.message,
          source: "SQL",
          code: null,
        })),
      );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, INSPECT_DELAY);
    };
    schedule();
    // The schema model arrives (or the console is bound to another source / schema) after the editor opens.
    const unsubscribe = useDatabase.subscribe((s, prev) => {
      if (
        s.completion !== prev.completion ||
        s.consoles !== prev.consoles ||
        s.consoleSchemas !== prev.consoleSchemas ||
        s.sources !== prev.sources
      )
        schedule();
    });
    // SQL resolution scopes can move the file to another data source.
    const unsubscribeSettings = useProject.subscribe((s, prev) => {
      if (s.settings !== prev.settings) schedule();
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        unsubscribe();
        unsubscribeSettings();
        setFileDiagnostics(path, INSPECTIONS, []);
      },
    };
  });
}

function definition(path: string, sql: SqlText): ContributedDefinition {
  const handle: ContributedDefinition = (view, pos) => {
    if (sql.at && !sql.at(view.state, pos)) return false;
    const r = resolver(path, view.state, sql).resolveAt(pos);
    const sym = r?.symbol;
    const id = consoleSource(path);
    if (r?.catalogTable && id && duckdbCatalogTree(sourceById(id))) {
      const { catalog, schema, table } = r.catalogTable;
      void revealInTree(id, schema, table, undefined, undefined, catalog);
      return true;
    }
    // Outside SQL names, other providers (the XML language server) may know the place.
    if (!sym && sql.at) return false;
    const reveal = (t: DbCompletionTable, column?: string) => {
      if (id) void revealInTree(id, t.schema, t.name, t.kind, column);
    };
    if (!sym) {
      showHint(view, "Cannot find declaration to go to");
      return true;
    }
    switch (sym.kind) {
      case "alias":
      case "cte":
        // On the definition itself: its table, as IDEA does.
        if (pos >= sym.def.from && pos <= sym.def.to) {
          if (sym.kind === "alias" && sym.table) reveal(sym.table);
          else showHint(view, "Cannot find declaration to go to");
        } else view.dispatch({ selection: { anchor: sym.def.from, head: sym.def.to }, scrollIntoView: true });
        return true;
      case "table":
        reveal(sym.table);
        return true;
      case "column":
        if (sym.table) reveal(sym.table, sym.name);
        else showHint(view, "Cannot find declaration to go to");
        return true;
      case "schema":
        showHint(view, "Cannot find declaration to go to");
        return true;
    }
  };
  const at = sql.at;
  if (at) handle.canHandle = (state, pos) => at(state, pos);
  return handle;
}

const code = (s: string) => `\`${s.replace(/`/g, "")}\``;

function tableDoc(t: DbCompletionTable, model: DbCompletion | null): string {
  const fks = (model?.foreignKeys ?? []).filter((k) => k.schema === t.schema && k.table === t.name);
  const refOf = (c: string) => {
    const k = fks.find((f) => f.columns.includes(c));
    return k ? `→ ${k.refTable} (${k.refColumns[k.columns.indexOf(c)] ?? ""})` : "";
  };
  // A comment column only when some column has a comment.
  const comments = t.columns.some((c) => c.comment);
  const rows = t.columns.map(
    (c) =>
      `| ${code(c.name)} | ${c.dataType} | ${[
        c.primaryKey ? "PK" : "",
        c.nullable ? "" : "not null",
        c.hasDefault ? "default" : "",
        refOf(c.name),
      ]
        .filter(Boolean)
        .join(", ")} |${comments ? ` ${tableCell(c.comment ?? "")} |` : ""}`,
  );
  return [
    `${t.kind === "materializedView" ? "materialized view" : t.kind} **${t.name}** in ${code(t.schema)}`,
    "",
    comments ? "| column | type | | comment |" : "| column | type | |",
    comments ? "|---|---|---|---|" : "|---|---|---|",
    ...rows,
  ].join("\n");
}

/** `text` as one Markdown table cell: pipes escaped, line breaks as spaces. */
function tableCell(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").replaceAll("|", "\\|");
}

function symbolDoc(sym: SqlSymbol, model: DbCompletion | null): string | null {
  switch (sym.kind) {
    case "table":
      return tableDoc(sym.table, model);
    case "alias":
      return sym.table ? `alias ${code(sym.name)} of\n\n${tableDoc(sym.table, model)}` : `alias ${code(sym.name)}`;
    case "cte":
      return `common table expression ${code(sym.name)}`;
    case "schema":
      return `schema ${code(sym.name)}`;
    case "column": {
      const c = sym.column;
      const owner = sym.table ? `${sym.table.schema}.${sym.table.name}` : sym.owner;
      if (!c) return `column ${code(sym.name)} of ${code(owner)}`;
      const traits = [
        c.primaryKey ? "primary key" : "",
        c.nullable ? "" : "not null",
        c.hasDefault ? "has default" : "",
      ].filter(Boolean);
      const comment = c.comment ? `\n\n${c.comment}` : "";
      return `column **${c.name}** ${code(c.dataType)}${traits.length ? ` ${traits.join(", ")}` : ""}${comment}\n\nof ${code(owner)}`;
    }
  }
}

function hover(path: string, sql: SqlText): ContributedHover {
  return (state, pos) => {
    if (sql.at && !sql.at(state, pos)) return null;
    const r = resolver(path, state, sql).resolveAt(pos);
    const markdown = r?.symbol ? symbolDoc(r.symbol, sourceOf(path).model) : null;
    return r && markdown ? { from: r.from, to: r.to, markdown } : null;
  };
}

function formatter(path: string): ContributedFormatter {
  return (state, range) => formatSql(state.doc.toString(), sourceOf(path).driver, range, sqlCaseStyle(editorPrefs()));
}

/** Inspections, navigation and documentation for the SQL of `path` (and Reformat Code for SQL files). */
export function sqlSupport(path: string, sql: SqlText = WHOLE_FILE): Extension {
  const data = {
    [CONTRIBUTED_DEFINITION]: definition(path, sql),
    [CONTRIBUTED_HOVER]: hover(path, sql),
    ...(sql === WHOLE_FILE ? { [CONTRIBUTED_FORMAT]: formatter(path) } : {}),
  };
  return [inspections(path, sql), EditorState.languageData.of(() => [data])];
}
