/**
 * SQL in MyBatis mapper XML: the statements of `<select>`, `<insert>`, `<update>`, `<delete>`
 * and `<sql>` are highlighted as SQL and get the SQL file's tools — completion, inspections,
 * Go to Declaration and Quick Documentation — against the file's data source (its SQL
 * resolution scope, or the project's only data source). See `sql/mapper` for what is SQL.
 */
import { MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL, type SQLDialect } from "@codemirror/lang-sql";
import { highlightingFor } from "@codemirror/language";
import { EditorState, RangeSetBuilder, StateEffect, type Extension, type Text } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import type { EditorDocContext } from "@/editor/api";
import type { DbDriver } from "@/platform/ipc";
import { completionSource } from "./console";
import { inMapperSql, isMapper, mapperSql, type MapperSql } from "./sql/mapper";
import { sqlSupport, type SqlText } from "./sqlSupport";
import { consoleSource, sourceById, useDatabase } from "./store";

const cache = new WeakMap<Text, MapperSql | null>();
/** The file's data source (and so its dialect) changed: colour the statements again. */
const recolour = StateEffect.define<null>();

/** The SQL of the mapper in `doc` (null when it is no mapper), computed once per document version. */
function mapperOf(doc: Text): MapperSql | null {
  let sql = cache.get(doc);
  if (sql === undefined) {
    const text = doc.toString();
    sql = isMapper(text) ? mapperSql(text) : null;
    cache.set(doc, sql);
  }
  return sql;
}

const MAPPER_SQL: SqlText = {
  text: (state) => mapperOf(state.doc)?.text ?? " ".repeat(state.doc.length),
  at: (state, pos) => {
    const sql = mapperOf(state.doc);
    return !!sql && inMapperSql(sql, pos);
  },
};

function dialectOf(driver: DbDriver): SQLDialect {
  switch (driver) {
    case "postgres":
      return PostgreSQL;
    case "mysql":
      return MySQL;
    case "sqlite":
      return SQLite;
    case "sqlServer":
      return MSSQL;
    case "oracle":
      return PLSQL;
    default:
      return StandardSQL;
  }
}

/** Syntax colours of the statements, in the bound data source's dialect, over the XML colours. */
function sqlColours(path: string): Extension {
  const build = (view: EditorView): DecorationSet => {
    const sql = mapperOf(view.state.doc);
    if (!sql?.segments.length) return Decoration.none;
    const driver = sourceById(consoleSource(path))?.driver ?? "sqlite";
    const tree = dialectOf(driver).language.parser.parse(sql.text);
    const builder = new RangeSetBuilder<Decoration>();
    const marks = new Map<string, Decoration>();
    const style = { style: (tags: Parameters<typeof highlightingFor>[1]) => highlightingFor(view.state, tags) };
    let segment = 0;
    for (const { from, to } of view.visibleRanges)
      highlightTree(
        tree,
        style,
        (a, b, cls) => {
          // Only the file's own SQL text: the words standing in for tags are not shown.
          while (segment < sql.segments.length && sql.segments[segment]!.to <= a) segment++;
          for (let i = segment; i < sql.segments.length && sql.segments[i]!.from < b; i++) {
            const s = sql.segments[i]!;
            const f = Math.max(a, s.from);
            const t = Math.min(b, s.to);
            if (f >= t) continue;
            let mark = marks.get(cls);
            if (!mark) marks.set(cls, (mark = Decoration.mark({ class: cls })));
            builder.add(f, t, mark);
          }
        },
        from,
        to,
      );
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private stop: () => void;
      constructor(readonly view: EditorView) {
        this.decorations = build(view);
        // Another data source may mean another dialect.
        this.stop = useDatabase.subscribe((s, prev) => {
          if (s.sources !== prev.sources || s.consoles !== prev.consoles)
            queueMicrotask(() => view.dispatch({ effects: recolour.of(null) }));
        });
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(recolour))))
          this.decorations = build(u.view);
      }
      destroy() {
        this.stop();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** The SQL support of MyBatis mapper `ctx.path` (inert in other XML files). */
export function mapperExtension(ctx: EditorDocContext): Extension {
  return [
    sqlColours(ctx.path),
    EditorState.languageData.of(() => [{ openideaCompletion: completionSource(ctx.path, MAPPER_SQL) }]),
    sqlSupport(ctx.path, MAPPER_SQL),
  ];
}
