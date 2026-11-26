import {
  autocompletion,
  completionKeymap,
  hasNextSnippetField,
  hasPrevSnippetField,
  snippet,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { findLanguageDescription, loadSupport } from "@/editor/core/cm/languages";
import { baseExtensions, compartments } from "@/editor/core/cm/setup";
import { executeAction } from "@/platform/actions";
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
import { Button, Dialog, IconButton, Input, Select, Spinner, T, Tabs, Toolbar } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { executionMarks, trackExecution } from "./executionMarks";
import { Grid } from "./Grid";
import { jdbcProfileOption, JdbcDriverProfiles, useJdbcDrivers } from "./JdbcDriverProfiles";
import { projectRequest } from "./requests";
import { formatElapsed } from "./resultView";
import { quoteIdent } from "./sql/complete";
import { identName, inLiteral, lex } from "./sql/lexer";
import { loadCompletion, loadSources, useDatabase } from "./store";
import { DUCKDB_JDBC_CLASS, vendorOf } from "./vendors";
import {
  WORKSPACE_SQL_LIMIT,
  workspaceJoinColumnOptions,
  workspaceJoinColumnTarget,
  workspaceJoinQuery,
  workspaceSourceAliasError,
  workspaceSourceNames,
  workspaceSourceSide,
  workspaceStatementRanges,
} from "./workspaceQuery";
import dbStyles from "./Database.module.css";
import styles from "./WorkspaceEditor.module.css";

const PAGE_SIZE = 500;
const MAX_BATCH_STATEMENTS = 12;
const MAX_BATCH_ROWS = 100_000;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

type WorkspaceResult = { sql: string; data: DbQueryResult; page: number };
type WorkspaceRun = { request: RequestId | null; cancelled: boolean };

// Estimate retained JS payload without serializing or copying the grid's rows.
function resultBytes(result: DbQueryResult, available: number): number {
  let bytes = 0;
  for (const column of result.columns) bytes += 64 + 2 * (column.name.length + column.typeName.length);
  for (const row of result.rows) {
    bytes += 24 + 8 * row.length;
    for (const cell of row) if (cell !== null) bytes += 24 + 2 * cell.length;
    if (bytes > available) break;
  }
  return bytes;
}

function resultLabel(n: number) {
  return tx`Result ${n}`;
}
const sides = ["left", "right"] as const;
type Side = (typeof sides)[number];
type Selections = Record<Side, string>;
type Configuration = Selections & { profile: string; sourceAliases: Record<string, string> };
type SourceReferences = { names: Selections; aliases: Selections; labels: Selections };

function preferredName({ names, aliases }: SourceReferences, side: Side): string {
  return aliases[side].trim() || names[side];
}

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

function complete(bindings: () => { config: Configuration; references: SourceReferences }): CompletionSource {
  return async (context) => {
    if (context.pos > WORKSPACE_SQL_LIMIT) return null;
    const sql = context.state.sliceDoc(0, context.pos);
    const parsed = lex(sql, "postgres");
    const state = inLiteral(parsed, context.pos);
    if (state === "string" || state === "comment") return null;
    const { config, references } = bindings();
    const { names, aliases, labels } = references;
    const target = workspaceJoinColumnTarget(sql, names, aliases, parsed);
    if (target && config[target.source]) {
      const current = projectRequest();
      const id = config[target.source];
      const catalog = useDatabase.getState().completion[id] ?? (await loadCompletion(id));
      const latest = bindings();
      if (
        !current() ||
        context.aborted ||
        (context.view && context.view.state.doc !== context.state.doc) ||
        !catalog ||
        latest.config.left !== config.left ||
        latest.config.right !== config.right
      )
        return null;
      const updated = workspaceJoinColumnTarget(sql, latest.references.names, latest.references.aliases, parsed);
      if (updated?.source !== target.source || updated.schema !== target.schema || updated.table !== target.table)
        return null;
      return { from: target.from, options: workspaceJoinColumnOptions(target, catalog), filter: false };
    }
    const hash = parsed.tokens.findLastIndex((token) => token.text === "#");
    if (hash < 0) return null;
    const tokens = parsed.tokens.slice(hash + 1);
    if (tokens.some((token) => token.kind !== "quoted" && token.kind !== "word" && token.text !== ".")) return null;
    const from = parsed.tokens[hash]!.from;
    const prefix = sql.slice(from);
    if (/\s$/.test(prefix) && state !== "quoted") return null;
    if (tokens.length < 2) {
      const typed = tokens[0]?.text.toLowerCase() ?? "";
      return {
        from,
        options: sides
          .filter((side) => config[side])
          .flatMap((side) => {
            const preferred = preferredName(references, side);
            const detail = labels[side] !== preferred ? labels[side] : undefined;
            const option = { label: sourcePrefix(preferred), type: "namespace", detail, boost: 5 };
            return typed && preferred !== side && side.startsWith(typed)
              ? [option, { label: sourcePrefix(side), type: "namespace", detail: labels[side] }]
              : [option];
          }),
      };
    }
    const name = tokens[0]!.kind === "quoted" ? identName(tokens[0]!) : tokens[0]!.text.toLowerCase();
    const side = workspaceSourceSide(name, names, aliases);
    if (!side || tokens[1]!.text !== "." || !config[side]) return null;
    const current = projectRequest();
    const id = config[side];
    const catalog = useDatabase.getState().completion[id] ?? (await loadCompletion(id));
    const latest = bindings();
    if (
      !current() ||
      context.aborted ||
      (context.view && context.view.state.doc !== context.state.doc) ||
      latest.config[side] !== id ||
      !catalog ||
      workspaceSourceSide(name, latest.references.names, latest.references.aliases) !== side
    )
      return null;
    const options = [];
    for (const table of catalog.tables) {
      if (table.kind !== "table") continue;
      const label =
        sourcePrefix(name) + "." + quoteIdent(table.schema, "postgres") + "." + quoteIdent(table.name, "postgres");
      if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
        options.push({ label, type: "class", detail: name === labels[side] ? table.kind : labels[side] });
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
    sourceAliases: Object.fromEntries(
      value.sourceAliases && typeof value.sourceAliases === "object"
        ? Object.entries(value.sourceAliases).filter((entry): entry is [string, string] => typeof entry[1] === "string")
        : [],
    ),
    sql: typeof value.sql === "string" ? value.sql : "",
  };
}

export function WorkspaceEditor({ input }: { input: EditorInput }) {
  const t = useTx();
  const storageKey = "openidea." + input.key;
  const [draft] = useState(() => readDraft(storageKey));
  const sources = useDatabase((state) => state.sources);
  const registry = useJdbcDrivers();
  const [config, setConfig] = useState<Configuration>({
    left: draft.left,
    right: draft.right,
    profile: draft.profile,
    sourceAliases: draft.sourceAliases,
  });
  const [settings, setSettings] = useState<Configuration | null>(null);
  const settingsRequested = useDatabase((state) => state.workspaceSettingsRequest === input.key);
  const [manage, setManage] = useState(false);
  const [empty, setEmpty] = useState(() => draft.sql.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<WorkspaceResult[]>([]);
  const [active, setActive] = useState("feedback");
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const running = useRef<WorkspaceRun | null>(null);
  const candidates = sources.filter(eligible);
  const drivers = registry.drivers?.filter((d) => d.vendor === "duckdb" && d.className === DUCKDB_JDBC_CLASS) ?? [];
  const driverFor = (id: string) => (id ? drivers.find((driver) => driver.id === id) : drivers[0]);
  const sourceFor = (id: string) => candidates.find((source) => source.id === id);
  const configured = (value: Configuration) =>
    !!driverFor(value.profile) && sides.every((side) => sourceFor(value[side])) && value.left !== value.right;
  const referencesFor = (value: Configuration): SourceReferences => {
    const labels = { left: sourceFor(value.left)?.name ?? "", right: sourceFor(value.right)?.name ?? "" };
    return {
      labels,
      names: workspaceSourceNames(labels.left, labels.right),
      aliases: {
        left: Object.hasOwn(value.sourceAliases, value.left) ? value.sourceAliases[value.left]! : "",
        right: Object.hasOwn(value.sourceAliases, value.right) ? value.sourceAliases[value.right]! : "",
      },
    };
  };
  const references = referencesFor(config);
  const aliasError = workspaceSourceAliasError(references.names, references.aliases);
  const ready = configured(config) && !aliasError;
  const settingsReferences = settings ? referencesFor(settings) : null;
  const settingsError = settingsReferences
    ? workspaceSourceAliasError(settingsReferences.names, settingsReferences.aliases)
    : null;
  const current = useRef({ config, references, execute: () => {} });

  useEffect(() => {
    if (!settingsRequested || busy) return;
    const frame = requestAnimationFrame(() => {
      useDatabase.setState({ workspaceSettingsRequest: null });
      setSettings(config);
    });
    return () => cancelAnimationFrame(frame);
  }, [settingsRequested, busy, config]);

  const stop = () => {
    const run = running.current;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    if (run.request !== null) void commands.cancelRequest(run.request);
  };
  const execute = async (script = false) => {
    const editor = view.current;
    if (running.current || !editor) return;
    const driver = driverFor(config.profile);
    if (!ready || !driver) {
      setSettings(config);
      return;
    }
    const state = editor.state;
    const range = state.selection.main;
    // Tab fields in Insert JOIN are selections for editing the template.
    const selected = !script && !range.empty && !hasNextSnippetField(state) && !hasPrevSnippetField(state);
    const from = selected ? range.from : 0;
    const to = selected ? range.to : state.doc.length;
    const submitted = selected || script;
    const reportError = (message: string) => {
      setError(message);
      setActive("feedback");
    };
    if (to - from > WORKSPACE_SQL_LIMIT) {
      reportError(tx("Workspace SQL exceeds 65,536 characters."));
      return;
    }
    const sql = state.sliceDoc(from, to);
    const spans = workspaceStatementRanges(sql, submitted ? undefined : range.head).map((span) => ({
      from: span.from + from,
      to: span.to + from,
    }));
    if (!spans.length) {
      editor.focus();
      return;
    }
    if (spans.length > MAX_BATCH_STATEMENTS) {
      reportError(tx("The workspace can run up to 12 statements at a time."));
      return;
    }
    const tracker = trackExecution(editor);
    const table = (ref: ReturnType<typeof workspaceJoinQuery>[number]) => {
      const source = sourceFor(config[ref.source])!;
      return {
        sourceId: source.id,
        database: source.driver === "clickhouse" ? ref.schema : "",
        schema: ref.schema,
        table: ref.table,
        key: ref.key,
      };
    };
    const queries = [];
    // Validate the entire batch before the first request touches either source.
    for (const span of spans) {
      const text = state.sliceDoc(span.from, span.to);
      try {
        const [a, b] = workspaceJoinQuery(text, references.names, references.aliases);
        queries.push({ text, left: table(a), right: table(b) });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        tracker.start([span]);
        tracker.update(null, [{ index: 0, error, ms: null }]);
        tracker.end();
        reportError(error);
        return;
      }
    }
    const activeProject = projectRequest();
    const run: WorkspaceRun = { request: null, cancelled: false };
    const ownsRun = () => activeProject() && running.current === run;
    running.current = run;
    setError("");
    setResults([]);
    setActive("feedback");
    setBusy(true);
    tracker.start(spans);
    let rows = 0;
    let bytes = 0;
    try {
      for (const [index, { text, left, right }] of queries.entries()) {
        if (!ownsRun()) break;
        if (run.cancelled) {
          reportError(tx("Cancelled"));
          break;
        }
        const request = nextRequestId();
        run.request = request;
        const startedAt = Date.now();
        tracker.update({ index, startedAt });
        try {
          // Each JOIN owns the source reads and staging until it finishes.
          // oxlint-disable-next-line no-await-in-loop
          const data = await call(commands.dbWorkspaceJoin(request, driver.id, left, right));
          if (!ownsRun()) break;
          rows += data.rows.length;
          bytes += resultBytes(data, MAX_BATCH_BYTES - bytes);
          if (rows > MAX_BATCH_ROWS || bytes > MAX_BATCH_BYTES)
            throw new Error(tx("The workspace batch exceeds the result size limit."));
          tracker.update(null, [{ index, error: null, ms: data.elapsedMs ?? Date.now() - startedAt }]);
          setResults((previous) => [...previous, { sql: text, page: 0, data }]);
          setActive(String(index));
        } catch (e) {
          if (!ownsRun()) break;
          const error = isCancelled(e) ? tx("Cancelled") : e instanceof Error ? e.message : String(e);
          tracker.update(null, [{ index, error, ms: Date.now() - startedAt }]);
          reportError(error);
          break;
        } finally {
          run.request = null;
        }
      }
    } finally {
      if (running.current === run) {
        running.current = null;
        tracker.end();
        setBusy(false);
      }
    }
  };
  useLayoutEffect(() => {
    current.current = { config, references, execute: () => void execute() };
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
            executionMarks,
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
    const panel = editor.dom.closest("[data-editor-focus]");
    const focusEditor = () => editor.focus();
    panel?.addEventListener("focus", focusEditor);
    if (panel) focusEditor();
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
      stop();
      running.current = null;
      save();
      editor.dom.removeEventListener("focusout", save);
      panel?.removeEventListener("focus", focusEditor);
      window.removeEventListener("pagehide", save);
      view.current = null;
      editor.destroy();
    };
  }, [draft, storageKey]);

  const template = joinTemplate(
    ready
      ? { left: preferredName(references, "left"), right: preferredName(references, "right") }
      : { left: "accounts", right: "events" },
  );
  const insertJoin = () => {
    const editor = view.current;
    if (!editor || editor.state.doc.length) return;
    snippet(template)(editor, null, 0, 0);
    editor.focus();
  };
  const applySettings = () => {
    if (!settings || !configured(settings) || settingsError) return;
    const next = {
      ...settings,
      profile: driverFor(settings.profile)!.id,
      sourceAliases: Object.fromEntries(
        Object.entries(settings.sourceAliases)
          .map(([id, alias]) => [id, alias.trim()])
          .filter(([, alias]) => alias),
      ),
    };
    if (
      next.left !== config.left ||
      next.right !== config.right ||
      next.profile !== config.profile ||
      JSON.stringify(next.sourceAliases) !== JSON.stringify(config.sourceAliases)
    ) {
      setConfig(next);
      setResults([]);
      setActive("feedback");
      setError("");
    }
    setSettings(null);
    const editor = view.current;
    requestAnimationFrame(() => {
      if (view.current === editor) editor?.focus();
    });
  };
  const result = results[Number(active)];
  const start = (result?.page ?? 0) * PAGE_SIZE;
  const first = start + 1;
  const total = result?.data.rows.length ?? 0;
  const last = Math.min(start + PAGE_SIZE, total);
  const hasFeedback = busy || results.length > 0 || !!error;
  const setPage = (page: number) =>
    setResults((previous) => previous.map((item) => (item === result ? { ...item, page } : item)));
  const configureLabel = t("Configure Sources…");
  const connectionContext = ready
    ? [
        configureLabel,
        ...sides.map((side) => {
          const source = sourceFor(config[side])!;
          return `${source.name || source.id} (${vendorOf({ driver: source.driver }).label})`;
        }),
        driverFor(config.profile)!.name,
      ].join(" · ")
    : configureLabel;
  const newSource = () => void executeAction("db.newDataSource");
  return (
    <section className={styles.workspace} aria-label={t("Query Workspace")}>
      <Toolbar className={styles.toolbar} aria-label="Workspace actions">
        {busy ? (
          <IconButton icon="stop" title="Stop" tone="danger" onClick={stop} />
        ) : (
          <>
            <IconButton
              icon="run"
              title="Run"
              tone="accent"
              shortcut={shortcutLabel("db.execute")}
              onClick={() => void execute()}
            />
            <IconButton icon="gutter-run-all" title="Execute Script" onClick={() => void execute(true)} />
          </>
        )}
        <Button
          variant="ghost"
          size="small"
          className={styles.context}
          aria-label={connectionContext}
          title={connectionContext}
          disabled={busy}
          onClick={() => setSettings(config)}
        >
          <span>
            {ready ? `${preferredName(references, "left")} ↔ ${preferredName(references, "right")}` : configureLabel}
          </span>
        </Button>
      </Toolbar>
      <div className={styles.query} data-result={hasFeedback ? "" : undefined}>
        <div className={styles.editor} ref={host} />
        {empty && (
          <div className={styles.firstRun}>
            {ready ? (
              <T>Use qualified table names to join the selected sources.</T>
            ) : candidates.length < 2 ? (
              <T>Save two PostgreSQL or ClickHouse data sources first.</T>
            ) : (
              <T>Choose two saved data sources and a DuckDB JDBC driver.</T>
            )}
            <JoinExample template={template} />
            <div className={styles.firstRunActions}>
              {ready ? (
                <Button variant="secondary" size="small" onClick={insertJoin}>
                  <T>Insert JOIN</T>
                </Button>
              ) : candidates.length < 2 ? (
                <Button variant="primary" size="small" onClick={newSource}>
                  <T>New Data Source…</T>
                </Button>
              ) : (
                <Button variant="primary" size="small" onClick={() => setSettings(config)}>
                  <T>Configure Sources…</T>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {hasFeedback && (
        <>
          <Tabs
            className={dbStyles.resultTabs}
            variant="compact"
            aria-label={t("Results")}
            activeId={active}
            panelIdPrefix={panelId}
            onSelect={setActive}
            items={[
              { id: "feedback", label: "Feedback", icon: "db-console" },
              ...results.map(({ sql }, index) => ({
                id: String(index),
                label: resultLabel(index + 1),
                icon: "db-table",
                verbatim: true,
                tooltip: sql,
              })),
            ]}
            focusContent={() => {
              const target = panel.current?.querySelector<HTMLElement>('[role="grid"], [role="log"]');
              target?.focus();
              return !!target && document.activeElement === target;
            }}
          />
          <div
            ref={panel}
            className={styles.results}
            role="tabpanel"
            id={`${panelId}-panel-${active}`}
            aria-labelledby={`${panelId}-tab-${active}`}
          >
            {result ? (
              <>
                <div className={dbStyles.fill}>
                  <Grid
                    key={`${active}-${result.page}`}
                    columns={result.data.columns.map((c) => ({ name: c.name, type: c.typeName }))}
                    rowCount={Math.min(PAGE_SIZE, result.data.rows.length - start)}
                    firstRowNumber={first}
                    value={(row, col) => result.data.rows[start + row]?.[col] ?? null}
                  />
                </div>
                <div className={dbStyles.pagerDock}>
                  <Toolbar className={dbStyles.resultPager} aria-label={t("Result pages")}>
                    {result.data.rows.length > PAGE_SIZE ? (
                      <>
                        <IconButton
                          size="small"
                          icon="chevron-left"
                          title="Previous Page"
                          disabled={result.page === 0}
                          onClick={() => setPage(result.page - 1)}
                        />
                        <span className={dbStyles.resultPagerRange}>{t`${first}-${last} of ${total}`}</span>
                        <IconButton
                          size="small"
                          icon="chevron-right"
                          title="Next Page"
                          disabled={start + PAGE_SIZE >= result.data.rows.length}
                          onClick={() => setPage(result.page + 1)}
                        />
                      </>
                    ) : (
                      <span className={dbStyles.resultPagerRange}>{t`${result.data.rows.length} rows`}</span>
                    )}
                  </Toolbar>
                </div>
              </>
            ) : (
              <div role="log" tabIndex={0} className={dbStyles.output} aria-label={t("Feedback")}>
                {results.map(({ data }, index) => (
                  <div key={index} className={dbStyles.outputLine}>
                    {resultLabel(index + 1)} · {t`${data.rows.length} rows`}
                    {data.elapsedMs !== null && ` · ${formatElapsed(data.elapsedMs)}`}
                  </div>
                ))}
                {error && (
                  <div role="alert" className={dbStyles.outputError}>
                    {error}
                  </div>
                )}
                {busy && (
                  <div role="status" className={styles.running}>
                    <Spinner label={t("Running query")} /> <T>Running query</T>
                  </div>
                )}
              </div>
            )}
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
            {
              label: "OK",
              role: "default",
              disabled: !configured(settings) || !!settingsError,
              onClick: applySettings,
            },
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
                <small className={styles.driverMode}>
                  <T>In memory</T>
                </small>
              </span>
              <Select
                aria-label={t("Workspace DuckDB driver")}
                aria-description={t("In memory")}
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
            {settingsReferences && sides.some((side) => sourceFor(settings[side])) && (
              <div className={styles.aliasFields}>
                <p>
                  <T>Use a short SQL name for a source. Leave it blank to use the connection name.</T>
                </p>
                {sides
                  .filter((side) => sourceFor(settings[side]))
                  .map((side) => (
                    <label key={side} className={styles.field}>
                      <span>{t(side === "left" ? "Left SQL alias" : "Right SQL alias")}</span>
                      <Input
                        aria-label={t(side === "left" ? "Left SQL alias" : "Right SQL alias")}
                        mono
                        invalid={!!settingsError}
                        value={settingsReferences.aliases[side]}
                        placeholder={settingsReferences.labels[side]}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            sourceAliases: { ...settings.sourceAliases, [settings[side]]: event.target.value },
                          })
                        }
                      />
                    </label>
                  ))}
              </div>
            )}
            {settingsError && <p role="alert">{settingsError}</p>}
            {registry.error && <div role="alert">{registry.error}</div>}
            {candidates.length < 2 && (
              <div className={styles.settingsActions}>
                <p>
                  <T>Save two PostgreSQL or ClickHouse data sources first.</T>
                </p>
                <Button variant="secondary" size="small" onClick={newSource}>
                  <T>New Data Source…</T>
                </Button>
              </div>
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
