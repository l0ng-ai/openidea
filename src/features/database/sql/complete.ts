/**
 * SQL completion candidates (DataGrip-style): what fits the caret context
 * from the analysed statement and the data source's schema model — tables
 * after FROM / JOIN (with ready-made join clauses from foreign keys), columns
 * of the tables in scope with their owner and type, join conditions after ON,
 * dialect functions and the keywords that may follow.
 */
import type { DbCompletion, DbCompletionColumn, DbCompletionTable, DbDriver } from "@/platform/ipc";
import type { Analysis, Clause, TableRef } from "./analyze";
import { DATA_TYPES, functions, isReserved, joinKeywords, predicateKeywords, statementStarters } from "./dialect";

export type CandidateKind =
  | "table"
  | "view"
  | "column"
  /** Several columns at once (`id, email, name`). */
  | "columns"
  | "keyword"
  | "function"
  | "schema"
  | "alias"
  | "join"
  | "type";

export interface SqlCandidate {
  /** Filter / display text. */
  label: string;
  kind: CandidateKind;
  /** Grey text after the label: `(o)`, `(main)`, a signature. */
  tail?: string;
  /** Right-aligned: column type, data source. */
  type?: string;
  /** Text inserted instead of `label`. */
  insert?: string;
  /** Inserted as a snippet: `${}` marks the caret. */
  snippet?: string;
  /** Ranking within the popup (higher first). */
  boost: number;
  /** Also append `FROM <this>` to the statement (column picked before any FROM). */
  addFrom?: string;
  /** Re-open completion after inserting (`schema.`). */
  retrigger?: boolean;
  /** Column decorations. */
  primaryKey?: boolean;
  foreignKey?: boolean;
  /** Side-panel documentation (plain text). */
  doc?: string;
}

/** Match the console's automatic trigger: a word or a qualifier followed by a dot. */
export function shouldAutoCompleteSql(analysis: Analysis): boolean {
  const typed = analysis.prefix.text;
  return analysis.context.kind !== "none" && (!!typed || !!analysis.qualifier) && !/^\d/.test(typed);
}

const MAX_ALL_COLUMNS = 3000;

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** `name`, quoted when the dialect needs it (case, characters, reserved words). */
export function quoteIdent(name: string, driver: DbDriver): string {
  const plain = driver === "postgres" ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  if (plain.test(name) && !isReserved(name)) return name;
  const q = driver === "mysql" ? "`" : '"';
  return q + name.split(q).join(q + q) + q;
}

/** A short alias for `table` not in `taken`: `order_items` → `oi`, `users` → `u`. */
export function aliasFor(table: string, taken: ReadonlySet<string>): string {
  const words = table
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\s.$-]+/)
    .filter(Boolean);
  let base =
    words
      .map((w) => w[0]!)
      .join("")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "") || "t";
  if (/^\d/.test(base)) base = `t${base}`;
  if (isReserved(base)) base = `${base}1`;
  let a = base;
  for (let n = 1; taken.has(a.toLowerCase()); n++) a = `${base}${n}`;
  return a;
}

export interface CompletionInput {
  model: DbCompletion | null;
  analysis: Analysis;
  driver: DbDriver;
  /** Data source name, shown next to tables like IDEA does. */
  sourceName?: string;
}

export function sqlCandidates({ model, analysis: a, driver, sourceName }: CompletionInput): SqlCandidate[] {
  const ctx = a.context;
  if (ctx.kind === "none") return [];
  const typedLower = /[a-z]/.test(a.prefix.text) && !/[A-Z]/.test(a.prefix.text);
  const typedUpper = /[A-Z]/.test(a.prefix.text) && !/[a-z]/.test(a.prefix.text);
  const lower = typedLower || (!typedUpper && a.lowerKeywords);
  const kw = (k: string) => (lower ? k.toLowerCase() : k);
  const tables = model?.tables ?? [];
  const defaultSchema = model?.defaultSchema ?? "";
  const q = (n: string) => quoteIdent(n, driver);
  const out: SqlCandidate[] = [];
  const keywords = (list: readonly string[], boost: number) => {
    for (const k of list) out.push({ label: kw(k), kind: "keyword", boost });
  };

  const findTable = (schema: string | null, name: string): DbCompletionTable | undefined =>
    schema
      ? tables.find((t) => eq(t.schema, schema) && eq(t.name, name))
      : (tables.find((t) => eq(t.schema, defaultSchema) && eq(t.name, name)) ?? tables.find((t) => eq(t.name, name)));
  const columnsOf = (r: TableRef): Array<Pick<DbCompletionColumn, "name"> & Partial<DbCompletionColumn>> =>
    r.columns ? r.columns.map((name) => ({ name })) : (findTable(r.schema, r.name)?.columns ?? []);
  const refName = (r: TableRef) => r.alias ?? r.name;
  /** Owner shown after a column: the alias, else the table qualified by its schema (IDEA's `(main.users)`). */
  const ownerOf = (r: TableRef) => {
    if (r.alias || r.kind !== "table") return refName(r);
    const t = findTable(r.schema, r.name);
    return t?.schema ? `${t.schema}.${t.name}` : r.name;
  };
  /** One candidate inserting several columns: `id, email, name`. */
  const columnsCandidate = (r: TableRef, names: readonly string[], boost: number, qualify: boolean): SqlCandidate => ({
    label: names.join(", "),
    kind: "columns",
    tail: `(${ownerOf(r)})`,
    insert: names.map((n) => (qualify ? `${q(refName(r))}.${q(n)}` : q(n))).join(", "),
    boost,
  });
  const fkColumns = new Set(
    (model?.foreignKeys ?? []).flatMap((k) => k.columns.map((c) => `${k.schema}\u0000${k.table}\u0000${c}`)),
  );
  const isFk = (t: DbCompletionTable | undefined, c: string) =>
    !!t && fkColumns.has(`${t.schema}\u0000${t.name}\u0000${c}`);
  /** How a table is written from here: unqualified in the default schema. */
  const tableText = (t: DbCompletionTable) =>
    eq(t.schema, defaultSchema) || driver === "sqlite" ? q(t.name) : `${q(t.schema)}.${q(t.name)}`;
  const tableCandidate = (t: DbCompletionTable, boost: number, qualified = false): SqlCandidate => ({
    label: t.name,
    kind: t.kind !== "table" ? "view" : "table",
    tail: t.schema ? `(${t.schema})` : undefined,
    type: sourceName,
    insert: qualified ? `${q(t.schema)}.${q(t.name)}` : tableText(t),
    boost,
    doc: tableDoc(t),
  });
  const columnCandidate = (
    c: Partial<DbCompletionColumn> & { name: string },
    owner: string,
    table: DbCompletionTable | undefined,
    boost: number,
    insert?: string,
  ): SqlCandidate => ({
    label: c.name,
    kind: "column",
    tail: `(${owner})`,
    type: c.dataType ? c.dataType.toUpperCase() : undefined,
    insert: insert ?? q(c.name),
    boost,
    primaryKey: !!c.primaryKey,
    foreignKey: isFk(table, c.name),
    doc: c.dataType
      ? `${owner}.${c.name} ${c.dataType}${c.nullable === false ? " NOT NULL" : ""}${c.primaryKey ? " PRIMARY KEY" : ""}`
      : undefined,
  });

  // ---- `qualifier.` ----------------------------------------------------------
  if (a.qualifier) {
    const [first, second] = a.qualifier;
    if (a.qualifier.length === 1 && ctx.kind !== "table") {
      const ref = a.refs.find((r) => eq(r.alias, first) || (!r.alias && eq(r.name, first)));
      if (ref) {
        const t = ref.kind === "table" ? findTable(ref.schema, ref.name) : undefined;
        return columnsOf(ref).map((c) => columnCandidate(c, refName(ref), t, 50));
      }
    }
    if (a.qualifier.length === 1) {
      const inSchema = tables.filter((t) => eq(t.schema, first));
      if (inSchema.length) return inSchema.map((t) => ({ ...tableCandidate(t, 30), insert: q(t.name) }));
      const t = findTable(null, first!);
      if (t && ctx.kind !== "table") return t.columns.map((c) => columnCandidate(c, t.name, t, 50));
      return [];
    }
    const t = findTable(first!, second!);
    return t ? t.columns.map((c) => columnCandidate(c, t.name, t, 50)) : [];
  }

  switch (ctx.kind) {
    case "statement":
      // Below the live templates (`sel`, `ins`…), as in IDEA.
      keywords(statementStarters(driver), -10);
      return out;

    case "table": {
      const taken = new Set(a.refs.flatMap((r) => [refName(r).toLowerCase(), r.name.toLowerCase()]));
      if (ctx.join) out.push(...joinCandidates(a, model, driver, taken, kw));
      for (const c of a.ctes) out.push({ label: c.name, kind: "table", tail: "(CTE)", boost: 40 });
      const schemas = new Set<string>();
      for (const t of tables) {
        schemas.add(t.schema);
        const local = eq(t.schema, defaultSchema) || driver === "sqlite";
        out.push(tableCandidate(t, local ? (t.kind !== "table" ? 28 : 30) : 0, !local));
      }
      for (const s of schemas)
        if (!eq(s, defaultSchema) || schemas.size > 1)
          out.push({ label: s, kind: "schema", type: sourceName, insert: `${q(s)}.`, retrigger: true, boost: 5 });
      if (ctx.join) keywords(["LATERAL"], -10);
      return out;
    }

    case "afterTable": {
      if (!ctx.ref.alias && ctx.ref.kind === "table" && a.verb !== "INSERT" && a.verb !== "REPLACE") {
        // IDEA suggests an alias first.
        const taken = new Set(
          a.refs.filter((r) => r !== ctx.ref).flatMap((r) => [refName(r).toLowerCase(), r.name.toLowerCase()]),
        );
        out.push({ label: aliasFor(ctx.ref.name, taken), kind: "alias", boost: 45 });
      }
      if (a.verb === "UPDATE") keywords(["SET", "AS"], 20);
      else if (a.verb === "INSERT" || a.verb === "REPLACE") keywords(["VALUES", "SELECT", "DEFAULT VALUES"], 20);
      else if (a.verb === "DELETE") keywords(["WHERE", "AS", ...(driver === "postgres" ? ["USING"] : [])], 20);
      else {
        if (ctx.ref.viaJoin) {
          out.push(
            ...conditionCandidates(a, model, ctx.ref, kw).map((c) => ({
              ...c,
              label: `${kw("ON")} ${c.label}`,
              insert: `${kw("ON")} ${c.insert ?? c.label}`,
            })),
          );
          keywords(["ON", "USING"], 25);
        }
        keywords(["AS", "WHERE", ...joinKeywords(driver), "GROUP BY", "ORDER BY", "LIMIT", "UNION", "UNION ALL"], 10);
      }
      return out;
    }

    case "joinCondition":
      out.push(...conditionCandidates(a, model, ctx.ref, kw));
      columnContext("on");
      return out;

    case "insertColumns": {
      const t = ctx.target.kind === "table" ? findTable(ctx.target.schema, ctx.target.name) : undefined;
      const all = columnsOf(ctx.target);
      // The columns an INSERT needs (no default), then all of them.
      const required = all.filter((c) => !c.hasDefault).map((c) => c.name);
      if (required.length > 1) out.push(columnsCandidate(ctx.target, required, 60, false));
      if (all.length > 1 && all.length !== required.length)
        out.push(
          columnsCandidate(
            ctx.target,
            all.map((c) => c.name),
            55,
            false,
          ),
        );
      out.push(...all.map((c) => columnCandidate(c, ownerOf(ctx.target), t, 50)));
      keywords(["SELECT", "VALUES"], 5);
      return out;
    }

    case "afterInsertColumns":
      keywords(["VALUES", "SELECT"], 20);
      return out;

    case "column":
      columnContext(ctx.clause);
      return out;
  }

  function columnContext(clause: Clause) {
    const visible = a.refs;
    // `SET |` / `SET a = 1, |`: only the columns being assigned.
    const assigning = clause === "set" && (a.previous === "SET" || a.previous === ",");
    const inner = visible.filter((r) => r.depth === 0);
    // Column names in several tables of the block are inserted qualified.
    const count = new Map<string, number>();
    for (const r of inner)
      for (const c of columnsOf(r)) count.set(c.name.toLowerCase(), (count.get(c.name.toLowerCase()) ?? 0) + 1);
    const seen = new Set<string>();
    for (const r of visible) {
      const t = r.kind === "table" ? findTable(r.schema, r.name) : undefined;
      const owner = ownerOf(r);
      for (const c of columnsOf(r)) {
        const key = `${owner}\u0000${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ambiguous = r.depth > 0 || (count.get(c.name.toLowerCase()) ?? 0) > 1;
        out.push(
          columnCandidate(
            c,
            owner,
            t,
            r.depth === 0 ? 40 : 20,
            ambiguous ? `${q(refName(r))}.${q(c.name)}` : undefined,
          ),
        );
      }
      if (assigning) continue;
      out.push({ label: refName(r), kind: "alias", boost: 35 });
      // The whole column list (IDEA's "expand *" item in the select list).
      const names = columnsOf(r).map((c) => c.name);
      if (clause === "select" && r.depth === 0 && names.length > 1)
        out.push(columnsCandidate(r, names, 30, inner.length > 1));
    }
    if (assigning) return;
    if (!inner.length && a.fromInsert !== null && clause === "select") {
      // No FROM yet: any column, and accepting it adds the FROM.
      let n = 0;
      for (const t of tables) {
        if (!eq(t.schema, defaultSchema) && driver !== "sqlite") continue;
        for (const c of t.columns) {
          if (n++ > MAX_ALL_COLUMNS) break;
          out.push({ ...columnCandidate(c, t.name, t, 0), addFrom: tableText(t) });
        }
      }
    }
    for (const c of a.ctes)
      if (!visible.some((r) => eq(r.name, c.name))) out.push({ label: c.name, kind: "table", tail: "(CTE)", boost: 0 });
    const fnBoost = clause === "select" || clause === "having" ? 15 : 8;
    for (const f of functions(driver)) {
      const name = lower ? f.name : f.name.toUpperCase();
      out.push({
        label: name,
        kind: "function",
        tail: `(${f.params})`,
        type: f.returns?.toUpperCase(),
        snippet: f.params ? `${name}(\${})` : `${name}()`,
        boost: f.aggregate && clause !== "select" && clause !== "having" ? fnBoost - 4 : fnBoost,
      });
    }
    keywords(clauseKeywords(clause, driver, a), 5);
  }
}

function clauseKeywords(clause: Clause, driver: DbDriver, a: Analysis): string[] {
  const pred = predicateKeywords(driver);
  switch (clause) {
    case "select":
      return [
        "FROM",
        "DISTINCT",
        "AS",
        "CASE",
        "WHEN",
        "THEN",
        "ELSE",
        "END",
        "NULL",
        "NOT",
        "EXISTS",
        "CAST",
        ...(a.fromInsert !== null ? [] : ["WHERE"]),
      ];
    case "where":
    case "on":
    case "having":
      return [...pred, "GROUP BY", "ORDER BY", "LIMIT"];
    case "group":
      return ["HAVING", "ORDER BY", "LIMIT"];
    case "order":
      return ["ASC", "DESC", "LIMIT", "OFFSET", ...(driver === "mysql" ? [] : ["NULLS FIRST", "NULLS LAST"])];
    case "set":
      return ["WHERE", "DEFAULT", "NULL"];
    case "values":
      return ["DEFAULT", "NULL", "TRUE", "FALSE"];
    case "limit":
      return ["OFFSET"];
    case "returning":
      return ["AS"];
    default:
      return [...pred, ...DATA_TYPES[driver].map((t) => t.toUpperCase())];
  }
}

type Kw = (k: string) => string;

/**
 * `JOIN |` → whole join clauses to tables related to the ones in scope: by
 * foreign key either way, else by equal column names (IDEA does both).
 */
function joinCandidates(
  a: Analysis,
  model: DbCompletion | null,
  driver: DbDriver,
  taken: Set<string>,
  kw: Kw,
): SqlCandidate[] {
  if (!model) return [];
  const out: SqlCandidate[] = [];
  const q = (n: string) => quoteIdent(n, driver);
  const seen = new Set<string>();
  const local = (s: string) => eq(s, model.defaultSchema) || driver === "sqlite";
  const tableText = (schema: string, name: string) => (local(schema) ? q(name) : `${q(schema)}.${q(name)}`);
  for (const r of a.refs.filter((x) => x.depth === 0 && x.kind === "table")) {
    const rt = model.tables.find((t) => eq(t.name, r.name) && (r.schema ? eq(t.schema, r.schema) : true));
    if (!rt) continue;
    const ra = r.alias ?? r.name;
    const add = (schema: string, name: string, pairs: Array<[string, string]>, boost: number) => {
      const key = `${schema}.${name}:${pairs.join()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const alias = aliasFor(name, taken);
      const cond = pairs.map(([mine, theirs]) => `${q(ra)}.${q(mine)} = ${alias}.${q(theirs)}`).join(` ${kw("AND")} `);
      const text = `${tableText(schema, name)} ${alias} ${kw("ON")} ${cond}`;
      out.push({
        label: text,
        kind: "join",
        boost,
        type: undefined,
        doc: `Join ${name} on ${pairs.map(([m, t]) => `${ra}.${m} = ${t}`).join(", ")}`,
      });
    };
    for (const fk of model.foreignKeys) {
      // r references it: `orders o JOIN users u ON u.id = o.user_id`.
      if (eq(fk.schema, rt.schema) && eq(fk.table, rt.name))
        add(
          fk.refSchema,
          fk.refTable,
          fk.columns.map((c, i) => [c, fk.refColumns[i]!]),
          60,
        );
      // It references r: `users u JOIN orders o ON o.user_id = u.id`.
      if (eq(fk.refSchema, rt.schema) && eq(fk.refTable, rt.name))
        add(
          fk.schema,
          fk.table,
          fk.refColumns.map((c, i) => [c, fk.columns[i]!]),
          60,
        );
    }
    // Same-named key-ish columns (`user_id` ↔ `user_id`) with no declared key.
    const keyish = rt.columns.filter((c) => c.primaryKey || /_id$/i.test(c.name));
    for (const t of model.tables) {
      if (t === rt || !local(t.schema)) continue;
      for (const c of keyish) {
        if (c.primaryKey && eq(c.name, "id")) continue;
        if (t.columns.some((x) => eq(x.name, c.name))) add(t.schema, t.name, [[c.name, c.name]], 45);
      }
    }
  }
  return out;
}

/** `JOIN t x ON |` → conditions relating `ref` to the other tables in scope. */
function conditionCandidates(a: Analysis, model: DbCompletion | null, ref: TableRef, kw: Kw): SqlCandidate[] {
  if (!model || ref.kind !== "table") return [];
  const out: SqlCandidate[] = [];
  const find = (r: TableRef) =>
    model.tables.find((t) => eq(t.name, r.name) && (r.schema ? eq(t.schema, r.schema) : true));
  const mine = find(ref);
  if (!mine) return out;
  const ma = ref.alias ?? ref.name;
  const seen = new Set<string>();
  const add = (pairs: Array<[string, string]>, other: string, boost: number) => {
    const text = pairs.map(([m, o]) => `${other}.${o} = ${ma}.${m}`).join(` ${kw("AND")} `);
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ label: text, kind: "join", boost });
  };
  for (const r of a.refs) {
    if (r === ref || r.depth !== 0 || r.from > ref.from) continue;
    const t = r.kind === "table" ? find(r) : undefined;
    const oa = r.alias ?? r.name;
    if (t) {
      for (const fk of model.foreignKeys) {
        if (
          eq(fk.table, mine.name) &&
          eq(fk.schema, mine.schema) &&
          eq(fk.refTable, t.name) &&
          eq(fk.refSchema, t.schema)
        )
          add(
            fk.columns.map((c, i) => [c, fk.refColumns[i]!]),
            oa,
            60,
          );
        if (
          eq(fk.table, t.name) &&
          eq(fk.schema, t.schema) &&
          eq(fk.refTable, mine.name) &&
          eq(fk.refSchema, mine.schema)
        )
          add(
            fk.refColumns.map((c, i) => [c, fk.columns[i]!]),
            oa,
            60,
          );
      }
    }
    const theirs = t?.columns.map((c) => c.name) ?? r.columns ?? [];
    for (const c of mine.columns)
      if ((c.primaryKey && !eq(c.name, "id")) || /_id$/i.test(c.name))
        if (theirs.some((x) => eq(x, c.name))) add([[c.name, c.name]], oa, 45);
  }
  return out;
}

function tableDoc(t: DbCompletionTable): string {
  const width = Math.max(...t.columns.map((c) => c.name.length), 4);
  const cols = t.columns.map(
    (c) => `  ${c.name.padEnd(width)}  ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.primaryKey ? " PK" : ""}`,
  );
  return `${t.kind === "materializedView" ? "MATERIALIZED VIEW" : t.kind === "view" ? "VIEW" : "TABLE"} ${t.schema}.${t.name}\n${cols.join("\n")}`;
}
