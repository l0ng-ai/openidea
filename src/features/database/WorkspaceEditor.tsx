import { autocompletion, completionKeymap, type CompletionSource } from "@codemirror/autocomplete";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { baseExtensions, compartments } from "@/editor/core/cm/setup";
import { tx, useTx } from "@/platform/i18n";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DataSource,
  type DbQueryResult,
  type RequestId,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Button, Select, Spinner, T } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { Grid } from "./Grid";
import { jdbcProfileOption, JdbcDriverProfiles, useJdbcDrivers } from "./JdbcDriverProfiles";
import { projectRequest } from "./requests";
import { formatElapsed } from "./resultView";
import { quoteIdent } from "./sql/complete";
import { inLiteral, lex } from "./sql/lexer";
import { loadCompletion, loadSources, useDatabase } from "./store";
import { DUCKDB_JDBC_CLASS, vendorOf } from "./vendors";
import { workspaceJoinQuery } from "./workspaceQuery";
import styles from "./WorkspaceEditor.module.css";

const INITIAL_SQL =
  "SELECT *\nFROM #left.public.customers AS a\nJOIN #right.events.purchases AS b ON a.id = b.customer_id";
const PAGE_SIZE = 500;
type Side = "left" | "right";
type Selections = Record<Side, string>;

function eligible(source: DataSource): source is DataSource & { id: string } {
  return (
    !!source.id &&
    (source.driver === "postgres" || source.driver === "clickhouse") &&
    !source.options?.startupScript?.trim()
  );
}

function complete(selected: () => Selections): CompletionSource {
  return async (context) => {
    const sql = context.state.sliceDoc(0, context.pos);
    const parsed = lex(sql, "postgres");
    const state = inLiteral(parsed, context.pos);
    if (state === "string" || state === "comment") return null;
    const hash = parsed.tokens.findLastIndex((token) => token.text === "#");
    if (hash < 0) return null;
    const tokens = parsed.tokens.slice(hash + 1);
    if (tokens.some((token) => token.kind !== "quoted" && token.kind !== "word" && token.text !== ".")) return null;
    const from = parsed.tokens[hash]!.from;
    const prefix = sql.slice(from);
    if (/\s$/.test(prefix) && state !== "quoted") return null;
    const selection = selected();
    if (tokens.length < 2) {
      return {
        from,
        options: (["left", "right"] as const)
          .filter((side) => selection[side])
          .map((side) => ({ label: "#" + side, type: "namespace" })),
      };
    }
    const side = tokens[0]!.text.toLowerCase();
    if ((side !== "left" && side !== "right") || tokens[1]!.text !== "." || !selection[side]) return null;
    const current = projectRequest();
    const id = selection[side];
    const catalog = useDatabase.getState().completion[id] ?? (await loadCompletion(id));
    if (!current() || context.aborted || selected()[side] !== id || !catalog) return null;
    const options = [];
    for (const table of catalog.tables) {
      if (table.kind !== "table") continue;
      const label = "#" + side + "." + quoteIdent(table.schema, "postgres") + "." + quoteIdent(table.name, "postgres");
      if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
        options.push({ label, type: "class", detail: table.kind });
        if (options.length === 100) break;
      }
    }
    return { from, options, filter: false };
  };
}

function readDraft(key: string) {
  let value: Record<string, unknown> = {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (stored && typeof stored === "object") value = stored as Record<string, unknown>;
  } catch {
    /* Storage may be disabled. */
  }
  return {
    left: typeof value.left === "string" ? value.left : "",
    right: typeof value.right === "string" ? value.right : "",
    profile: typeof value.profile === "string" ? value.profile : "",
    sql: typeof value.sql === "string" ? value.sql : INITIAL_SQL,
  };
}

export function WorkspaceEditor({ input }: { input: EditorInput }) {
  const t = useTx();
  const storageKey = "openidea." + input.key;
  const [draft] = useState(() => readDraft(storageKey));
  const sources = useDatabase((state) => state.sources);
  const registry = useJdbcDrivers();
  const [selection, setSelection] = useState<Selections>({ left: draft.left, right: draft.right });
  const [profile, setProfile] = useState(draft.profile);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [page, setPage] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const request = useRef<RequestId | null>(null);
  const current = useRef({ selection, profile, execute: () => {} });
  const drivers = registry.drivers?.filter((d) => d.vendor === "duckdb" && d.className === DUCKDB_JDBC_CLASS) ?? [];
  const driver = profile ? drivers.find((d) => d.id === profile) : drivers[0];
  const candidates = sources.filter(eligible);
  const ready =
    !!driver &&
    [selection.left, selection.right].every((id) => candidates.some((s) => s.id === id)) &&
    selection.left !== selection.right;

  const execute = async () => {
    if (request.current !== null || !ready || !driver || !view.current) return;
    const activeProject = projectRequest();
    const id = nextRequestId();
    request.current = id;
    setError("");
    setResult(null);
    setPage(0);
    setBusy(true);
    try {
      const [a, b] = workspaceJoinQuery(view.current.state.doc.toString());
      const table = (ref: typeof a) => {
        const source = candidates.find((item) => item.id === selection[ref.source])!;
        return {
          sourceId: source.id,
          database: source.driver === "clickhouse" ? ref.schema : "",
          schema: ref.schema,
          table: ref.table,
          key: ref.key,
        };
      };
      const output = await call(commands.dbWorkspaceJoin(id, driver.id, table(a), table(b)));
      if (activeProject() && request.current === id) setResult(output);
    } catch (e) {
      if (activeProject() && request.current === id)
        setError(isCancelled(e) ? tx("Cancelled") : e instanceof Error ? e.message : String(e));
    } finally {
      if (request.current === id) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  useLayoutEffect(() => {
    current.current = { selection, profile, execute: () => void execute() };
  });

  useEffect(() => {
    if (!useDatabase.getState().loaded) void loadSources();
    if (!host.current) return;
    const sql = findLanguageDescription("SQL", "workspace.sql");
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: draft.sql,
        extensions: baseExtensions({
          ctx: { doc: -1, path: "workspace.sql", language: "sql", uiMode: "SQL", readOnly: false, virtual: true },
          settings: useProject.getState().settings?.editor,
          info: undefined,
          language: null,
          docLength: draft.sql.length,
          contributions: [],
          extra: [
            autocompletion({ override: [complete(() => current.current.selection)] }),
            Prec.highest(
              keymap.of([
                {
                  key: "Mod-Enter",
                  run: () => {
                    current.current.execute();
                    return true;
                  },
                },
                ...completionKeymap,
              ]),
            ),
            Prec.highest(EditorView.contentAttributes.of({ "aria-label": tx("Workspace SQL") })),
          ],
        }),
      }),
    });
    view.current = editor;
    const save = () => {
      const { selection, profile } = current.current;
      try {
        localStorage.setItem(storageKey, JSON.stringify({ ...selection, profile, sql: editor.state.doc.toString() }));
      } catch {
        /* The current session remains usable without storage. */
      }
    };
    editor.dom.addEventListener("focusout", save);
    window.addEventListener("pagehide", save);
    if (sql)
      void loadSupport(sql).then((language) => {
        if (view.current === editor && language)
          editor.dispatch({ effects: compartments.language.reconfigure(language) });
      });
    return () => {
      const pending = request.current;
      request.current = null;
      if (pending !== null) void commands.cancelRequest(pending);
      save();
      editor.dom.removeEventListener("focusout", save);
      window.removeEventListener("pagehide", save);
      view.current = null;
      editor.destroy();
    };
  }, [draft, storageKey]);

  const update = (side: Side, value: string) => {
    setSelection({ ...selection, [side]: value });
    setError("");
    setResult(null);
    setPage(0);
  };
  const start = page * PAGE_SIZE;
  return (
    <section className={styles.workspace} aria-label={t("Query Workspace")}>
      <div className={styles.toolbar}>
        {(["left", "right"] as const).map((side) => (
          <label key={side} className={styles.field}>
            <span>{"#" + side}</span>
            <Select
              aria-label={t(side === "left" ? "Left data source" : "Right data source")}
              searchable
              disabled={busy}
              value={selection[side]}
              placeholder="Select data source"
              options={candidates.map((s) => ({
                value: s.id,
                label: s.name || s.id,
                verbatim: true,
                icon: vendorOf(s).icon,
                disabled: s.id === selection[side === "left" ? "right" : "left"],
              }))}
              onChange={(id) => update(side, id)}
            />
          </label>
        ))}
        <Select
          aria-label={t("Workspace DuckDB driver")}
          value={driver?.id ?? null}
          disabled={busy}
          placeholder="Select DuckDB driver"
          options={drivers.map(jdbcProfileOption)}
          onChange={setProfile}
        />
        <Button variant="ghost" disabled={busy} onClick={() => setManage(true)}>
          <T>Manage Drivers…</T>
        </Button>
        {busy ? (
          <Button
            onClick={() => {
              if (request.current !== null) void commands.cancelRequest(request.current);
            }}
          >
            <T>Cancel</T>
          </Button>
        ) : (
          <Button variant="primary" icon="run" disabled={!ready} onClick={() => void execute()}>
            <T>Run</T>
          </Button>
        )}
      </div>
      <div className={styles.query} ref={host} />
      {registry.error && (
        <div role="alert" className={styles.status}>
          {registry.error}{" "}
          <Button onClick={registry.retry}>
            <T>Retry</T>
          </Button>
        </div>
      )}
      {busy && (
        <div className={styles.status}>
          <Spinner label={t("Running query")} /> <T>Running query</T>
        </div>
      )}
      {error && (
        <div role="alert" className={styles.status}>
          {error}
        </div>
      )}
      {result && (
        <>
          <div className={styles.status}>
            <span>{t`${result.rows.length} rows`}</span>
            {result.elapsedMs !== null && <span>{formatElapsed(result.elapsedMs)}</span>}
            {result.rows.length > PAGE_SIZE && (
              <>
                <Button size="small" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  <T>Previous Page</T>
                </Button>
                <span>
                  {start + 1}–{Math.min(start + PAGE_SIZE, result.rows.length)}
                </span>
                <Button
                  size="small"
                  disabled={start + PAGE_SIZE >= result.rows.length}
                  onClick={() => setPage(page + 1)}
                >
                  <T>Next Page</T>
                </Button>
              </>
            )}
          </div>
          <div className={styles.results}>
            <Grid
              key={page}
              columns={result.columns.map((c) => ({ name: c.name, type: c.typeName }))}
              rowCount={Math.min(PAGE_SIZE, result.rows.length - start)}
              firstRowNumber={start + 1}
              value={(row, col) => result.rows[start + row]?.[col] ?? null}
            />
          </div>
        </>
      )}
      {manage && registry.drivers && (
        <JdbcDriverProfiles
          drivers={registry.drivers}
          selected={driver?.id ?? ""}
          sourceVendor="duckdb"
          onClose={() => setManage(false)}
          onSave={(d) => {
            registry.setDrivers((old) => [...(old ?? []).filter((entry) => entry.id !== d.id), d]);
            setProfile(d.id);
          }}
          onUse={(d) => {
            setProfile(d.id);
            setManage(false);
          }}
          onRemove={(id) => registry.setDrivers((old) => (old ?? []).filter((d) => d.id !== id))}
        />
      )}
    </section>
  );
}
