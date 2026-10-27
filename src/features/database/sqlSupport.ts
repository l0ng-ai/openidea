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
  type ContributedDefinition,
  type ContributedFormatter,
  type ContributedHover,
} from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { showHint } from "@/editor/lsp/hint";
import { offsetToPos } from "@/editor/lsp/positions";
import type { DbCompletion, DbCompletionTable, DbDriver } from "@/platform/ipc";
import { formatSql } from "./sql/format";
import { SqlResolver, type SqlSymbol } from "./sql/resolve";
import { consoleSource, revealInTree, sourceById, useDatabase } from "./store";

/** Producer id of the console's diagnostics (Problems view, hover). */
const INSPECTIONS = "sql-inspections";
const INSPECT_DELAY = 400;

function sourceOf(path: string): { id: string | null; driver: DbDriver; model: DbCompletion | null } {
  const id = consoleSource(path);
  return {
    id,
    driver: sourceById(id)?.driver ?? "sqlite",
    model: id ? (useDatabase.getState().completion[id] ?? null) : null,
  };
}

function resolver(path: string, state: EditorState): SqlResolver {
  const { driver, model } = sourceOf(path);
  return new SqlResolver(state.doc.toString(), driver, model);
}

/** Unresolved tables / columns / aliases as error diagnostics, re-checked after edits and schema loads. */
function inspections(path: string): Extension {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const doc = view.state.doc;
      const problems = sourceOf(path).model ? resolver(path, view.state).problems() : [];
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
    // The schema model arrives (or the console is bound to another source) after the editor opens.
    const unsubscribe = useDatabase.subscribe((s, prev) => {
      if (s.completion !== prev.completion || s.consoles !== prev.consoles) schedule();
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        unsubscribe();
        setFileDiagnostics(path, INSPECTIONS, []);
      },
    };
  });
}

function definition(path: string): ContributedDefinition {
  return (view, pos) => {
    const r = resolver(path, view.state).resolveAt(pos);
    const sym = r?.symbol;
    const id = consoleSource(path);
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
}

const code = (s: string) => `\`${s.replace(/`/g, "")}\``;

function tableDoc(t: DbCompletionTable, model: DbCompletion | null): string {
  const fks = (model?.foreignKeys ?? []).filter((k) => k.schema === t.schema && k.table === t.name);
  const refOf = (c: string) => {
    const k = fks.find((f) => f.columns.includes(c));
    return k ? `→ ${k.refTable} (${k.refColumns[k.columns.indexOf(c)] ?? ""})` : "";
  };
  const rows = t.columns.map(
    (c) =>
      `| ${code(c.name)} | ${c.dataType} | ${[
        c.primaryKey ? "PK" : "",
        c.nullable ? "" : "not null",
        c.hasDefault ? "default" : "",
        refOf(c.name),
      ]
        .filter(Boolean)
        .join(", ")} |`,
  );
  return [
    `${t.kind === "materializedView" ? "materialized view" : t.kind} **${t.name}** in ${code(t.schema)}`,
    "",
    "| column | type | |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
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
      return `column **${c.name}** ${code(c.dataType)}${traits.length ? ` ${traits.join(", ")}` : ""}\n\nof ${code(owner)}`;
    }
  }
}

function hover(path: string): ContributedHover {
  return (state, pos) => {
    const r = resolver(path, state).resolveAt(pos);
    const markdown = r?.symbol ? symbolDoc(r.symbol, sourceOf(path).model) : null;
    return r && markdown ? { from: r.from, to: r.to, markdown } : null;
  };
}

function formatter(path: string): ContributedFormatter {
  return (state, range) => formatSql(state.doc.toString(), sourceOf(path).driver, range);
}

export function sqlSupport(path: string): Extension {
  const data = {
    [CONTRIBUTED_DEFINITION]: definition(path),
    [CONTRIBUTED_HOVER]: hover(path),
    [CONTRIBUTED_FORMAT]: formatter(path),
  };
  return [inspections(path), EditorState.languageData.of(() => [data])];
}
