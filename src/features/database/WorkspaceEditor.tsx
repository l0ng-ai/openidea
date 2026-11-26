import { autocompletion, completionKeymap, snippet, type CompletionSource } from "@codemirror/autocomplete";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { baseExtensions, compartments } from "@/editor/core/cm/setup";
import { tx, useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
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
import { Button, Dialog, IconButton, Select, Spinner, T, Toolbar } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { Grid } from "./Grid";
import { jdbcProfileOption, JdbcDriverProfiles, useJdbcDrivers } from "./JdbcDriverProfiles";
import { projectRequest } from "./requests";
import { formatElapsed } from "./resultView";
import { quoteIdent } from "./sql/complete";
import { identName, inLiteral, lex } from "./sql/lexer";
import { loadCompletion, loadSources, useDatabase } from "./store";
import { DUCKDB_JDBC_CLASS, vendorOf } from "./vendors";
import { workspaceJoinQuery, workspaceSourceNames, workspaceSourceSide } from "./workspaceQuery";
import styles from "./WorkspaceEditor.module.css";

const PAGE_SIZE = 500;
const sides = ["left", "right"] as const;
type Side = (typeof sides)[number];
type Selections = Record<Side, string>;
type Configuration = Selections & { profile: string };

function sourcePrefix(name: string) {
  return "#" + (name === "left" || name === "right" ? name : quoteIdent(name, "postgres"));
}

function joinTemplate(names: Selections) {
  const prefix = (side: Side) => sourcePrefix(names[side]).replace(/[{}]/g, "\\$&");
  return (
    "SELECT *\nFROM " +
    prefix("left") +
    ".${1:public}.${2:customers} AS a\nJOIN " +
    prefix("right") +
    ".${3:events}.${4:purchases} AS b\n  ON a.${5:id} = b.${6:customer_id}"
  );
}

const exampleKeywords = new Set(["SELECT", "FROM", "AS", "JOIN", "ON"]);

function JoinExample({ template }: { template: string }) {
  const sql = template.replace(/\$\{\d+:([^}]+)\}/g, "$1").replace(/\\([{}])/g, "$1");
  const tokens = lex(sql, "postgres").tokens.filter(
    (token) => token.kind === "quoted" || exampleKeywords.has(token.upper),
  );
  return (
    <pre className={styles.example}>
      <code>
        {tokens.map((token, index) => (
          <Fragment key={token.from}>
            {sql.slice(tokens[index - 1]?.to ?? 0, token.from)}
            <span className={token.kind === "quoted" ? styles.exampleName : styles.exampleKeyword}>{token.text}</span>
          </Fragment>
        ))}
        {sql.slice(tokens.at(-1)?.to ?? 0)}
      </code>
    </pre>
  );
}

function eligible(source: DataSource): source is DataSource & { id: string } {
  return (
    !!source.id &&
    (source.driver === "postgres" || source.driver === "clickhouse") &&
    !source.options?.startupScript?.trim()
  );
}

function complete(bindings: () => { config: Configuration; names: Selections }): CompletionSource {
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
    const { config, names } = bindings();
    if (tokens.length < 2) {
      return {
        from,
        options: sides
          .filter((side) => config[side])
          .flatMap((side) => [
            { label: sourcePrefix(names[side]), type: "namespace", boost: 5 },
            ...(names[side] === side ? [] : [{ label: sourcePrefix(side), type: "namespace" }]),
          ]),
      };
    }
    const name = tokens[0]!.kind === "quoted" ? identName(tokens[0]!) : tokens[0]!.text.toLowerCase();
    const side = workspaceSourceSide(name, names);
    if (!side || tokens[1]!.text !== "." || !config[side]) return null;
    const current = projectRequest();
    const id = config[side];
    const catalog = useDatabase.getState().completion[id] ?? (await loadCompletion(id));
    if (!current() || context.aborted || bindings().config[side] !== id || !catalog) return null;
    const options = [];
    for (const table of catalog.tables) {
      if (table.kind !== "table") continue;
      const label =
        sourcePrefix(name) + "." + quoteIdent(table.schema, "postgres") + "." + quoteIdent(table.name, "postgres");
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
    sql: typeof value.sql === "string" ? value.sql : "",
  };
}

export function WorkspaceEditor({ input }: { input: EditorInput }) {
  const t = useTx();
  const storageKey = "openidea." + input.key;
  const [draft] = useState(() => readDraft(storageKey));
  const sources = useDatabase((state) => state.sources);
  const registry = useJdbcDrivers();
  const [config, setConfig] = useState<Configuration>({ left: draft.left, right: draft.right, profile: draft.profile });
  const [settings, setSettings] = useState<Configuration | null>(null);
  const settingsRequested = useDatabase((state) => state.workspaceSettingsRequest === input.key);
  const [manage, setManage] = useState(false);
  const [empty, setEmpty] = useState(() => draft.sql.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [page, setPage] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const request = useRef<RequestId | null>(null);
  const candidates = sources.filter(eligible);
  const drivers = registry.drivers?.filter((d) => d.vendor === "duckdb" && d.className === DUCKDB_JDBC_CLASS) ?? [];
  const driverFor = (id: string) => (id ? drivers.find((driver) => driver.id === id) : drivers[0]);
  const sourceFor = (id: string) => candidates.find((source) => source.id === id);
  const configured = (value: Configuration) =>
    !!driverFor(value.profile) && sides.every((side) => sourceFor(value[side])) && value.left !== value.right;
  const ready = configured(config);
  const names = workspaceSourceNames(sourceFor(config.left)?.name ?? "", sourceFor(config.right)?.name ?? "");
  const current = useRef({ config, names, execute: () => {} });

  useEffect(() => {
    if (!settingsRequested || busy) return;
    const frame = requestAnimationFrame(() => {
      useDatabase.setState({ workspaceSettingsRequest: null });
      setSettings(config);
    });
    return () => cancelAnimationFrame(frame);
  }, [settingsRequested, busy, config]);

  const execute = async () => {
    if (request.current !== null || !view.current) return;
    const driver = driverFor(config.profile);
    if (!ready || !driver) {
      setSettings(config);
      return;
    }
    const sql = view.current.state.doc.toString();
    if (!sql.trim()) {
      view.current.focus();
      return;
    }
    const activeProject = projectRequest();
    const id = nextRequestId();
    request.current = id;
    setError("");
    setResult(null);
    setPage(0);
    setBusy(true);
    try {
      const [a, b] = workspaceJoinQuery(sql, names);
      const table = (ref: typeof a) => {
        const source = sourceFor(config[ref.source])!;
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
    current.current = { config, names, execute: () => void execute() };
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
            autocompletion({ override: [complete(() => current.current)] }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) setEmpty(update.state.doc.length === 0);
            }),
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
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ ...current.current.config, sql: editor.state.doc.toString() }),
        );
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

  const template = joinTemplate(names);
  const insertJoin = () => {
    const editor = view.current;
    if (!editor || editor.state.doc.length) return;
    snippet(template)(editor, null, 0, 0);
    editor.focus();
  };
  const applySettings = () => {
    if (!settings || !configured(settings)) return;
    const next = { ...settings, profile: driverFor(settings.profile)!.id };
    if (next.left !== config.left || next.right !== config.right || next.profile !== config.profile) {
      setConfig(next);
      setResult(null);
      setError("");
      setPage(0);
    }
    setSettings(null);
  };
  const start = page * PAGE_SIZE;
  return (
    <section className={styles.workspace} aria-label={t("Query Workspace")}>
      <Toolbar className={styles.toolbar} aria-label="Workspace actions">
        {busy ? (
          <IconButton
            icon="stop"
            title="Stop"
            tone="danger"
            onClick={() => {
              if (request.current !== null) void commands.cancelRequest(request.current);
            }}
          />
        ) : (
          <IconButton
            icon="run"
            title="Run"
            tone="accent"
            shortcut={shortcutLabel("db.execute")}
            onClick={() => void execute()}
          />
        )}
        <IconButton icon="settings" title="Configure Sources…" disabled={busy} onClick={() => setSettings(config)} />
        {busy && (
          <span className={styles.running}>
            <Spinner label={t("Running query")} /> <T>Running query</T>
          </span>
        )}
      </Toolbar>
      <div className={styles.query} data-result={result ? "" : undefined}>
        <div className={styles.editor} ref={host} />
        {empty && (
          <div className={styles.firstRun}>
            {ready ? (
              <T>Use qualified table names to join the selected sources.</T>
            ) : (
              <T>Choose two saved data sources and a DuckDB JDBC driver.</T>
            )}
            <JoinExample template={template} />
            <div className={styles.firstRunActions}>
              <Button variant="secondary" size="small" onClick={insertJoin}>
                <T>Insert JOIN</T>
              </Button>
              {!ready && (
                <Button variant="ghost" size="small" onClick={() => setSettings(config)}>
                  <T>Configure Sources…</T>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
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
      {settings && (
        <Dialog
          open
          title={t("Configure Workspace Sources")}
          width={440}
          onClose={() => {
            setManage(false);
            setSettings(null);
          }}
          buttons={[
            { label: "Cancel", role: "cancel" },
            { label: "OK", role: "default", disabled: !configured(settings), onClick: applySettings },
          ]}
        >
          <div className={styles.settings}>
            {sides.map((side) => (
              <label key={side} className={styles.field}>
                <span>{t(side === "left" ? "Left data source" : "Right data source")}</span>
                <Select
                  aria-label={t(side === "left" ? "Left data source" : "Right data source")}
                  searchable
                  value={settings[side]}
                  placeholder="Select data source"
                  options={candidates
                    .filter((s) => s.id !== settings[side === "left" ? "right" : "left"])
                    .map((s) => ({ value: s.id, label: s.name || s.id, verbatim: true, icon: vendorOf(s).icon }))}
                  onChange={(id) => setSettings({ ...settings, [side]: id })}
                />
              </label>
            ))}
            <label className={styles.field}>
              <span>
                <T>Workspace DuckDB driver</T>
              </span>
              <Select
                aria-label={t("Workspace DuckDB driver")}
                value={driverFor(settings.profile)?.id ?? null}
                placeholder="Select DuckDB driver"
                options={drivers.map(jdbcProfileOption)}
                onChange={(profile) => setSettings({ ...settings, profile })}
              />
            </label>
            <div className={styles.settingsActions}>
              <Button
                variant="ghost"
                icon="swap-panels"
                disabled={!settings.left && !settings.right}
                onClick={() => setSettings({ ...settings, left: settings.right, right: settings.left })}
              >
                <T>Swap Sides</T>
              </Button>
              <Button variant="ghost" disabled={registry.drivers === null} onClick={() => setManage(true)}>
                <T>Manage Drivers…</T>
              </Button>
              {registry.error && (
                <Button onClick={registry.retry}>
                  <T>Retry</T>
                </Button>
              )}
            </div>
            {registry.error && <div role="alert">{registry.error}</div>}
            {candidates.length < 2 && (
              <p>
                <T>Save two PostgreSQL or ClickHouse data sources first.</T>
              </p>
            )}
            {sides.some((side) => settings[side] && !sourceFor(settings[side])) && (
              <p role="alert">
                <T>A saved workspace source is unavailable.</T>
              </p>
            )}
            {settings.profile && registry.drivers && !driverFor(settings.profile) && (
              <p role="alert">
                <T>The saved DuckDB driver is unavailable.</T>
              </p>
            )}
          </div>
        </Dialog>
      )}
      {settings && manage && registry.drivers && (
        <JdbcDriverProfiles
          drivers={registry.drivers}
          selected={driverFor(settings.profile)?.id ?? ""}
          sourceVendor="duckdb"
          onClose={() => setManage(false)}
          onSave={(d) => {
            registry.setDrivers((old) => [...(old ?? []).filter((entry) => entry.id !== d.id), d]);
            setSettings({ ...settings, profile: d.id });
          }}
          onUse={(d) => {
            setSettings({ ...settings, profile: d.id });
            setManage(false);
          }}
          onRemove={(id) => registry.setDrivers((old) => (old ?? []).filter((d) => d.id !== id))}
        />
      )}
    </section>
  );
}
