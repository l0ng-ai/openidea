import {
  autocompletion,
  completionKeymap,
  hasNextSnippetField,
  hasPrevSnippetField,
  snippet,
  startCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { Button, Dialog, Icon, IconButton, Input, Select, Spinner, T, Tabs, Toolbar } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { executionMarks, trackExecution } from "./executionMarks";
import { Grid } from "./Grid";
import { jdbcProfileOption, JdbcDriverProfiles, useJdbcDrivers } from "./JdbcDriverProfiles";
import { sourceLabel, targetOf } from "./model";
import { projectRequest } from "./requests";
import { formatElapsed } from "./resultView";
import { quoteIdent } from "./sql/complete";
import { identName, inLiteral, lex } from "./sql/lexer";
import { loadCompletion, loadSources, useDatabase } from "./store";
import { DUCKDB_JDBC_CLASS, DUCKDB_JDBC_PREFIX, vendorOf } from "./vendors";
import {
  WORKSPACE_SQL_LIMIT,
  workspaceJoinColumnOptions,
  workspaceJoinColumnTarget,
  workspaceJoinQuery,
  workspaceSourceAliasError,
  workspaceSourceResolver,
  type WorkspaceSourceReference,
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
type Configuration = {
  profile: string;
  sourceAliases: Record<string, string>;
  legacySources: { left: string; right: string };
};
type SavedSource = DataSource & { id: string };
type SourceResolver = ReturnType<typeof workspaceSourceResolver>;

function sourcePrefix(name: string) {
  return "#" + quoteIdent(name, "postgres");
}

function preferredReference(ref: WorkspaceSourceReference, resolve: SourceResolver) {
  if (ref.alias && resolve(ref.alias)?.id === ref.id) return sourcePrefix(ref.alias);
  const prefix = sourcePrefix(ref.name);
  if (resolve(ref.name, prefix.startsWith('#"'))?.id === ref.id) return prefix;
  if (resolve(ref.name, true)?.id === ref.id) return '#"' + ref.name.replaceAll('"', '""') + '"';
  return undefined;
}

const JOIN_TEMPLATE =
  "SELECT *\nFROM ${1:#source_a}.${3:schema.table_a} AS a\nJOIN ${2:#source_b}.${4:schema.table_b} AS b\n  ON a.${5:key} = b.${6:key}";

const exampleKeywords = new Set(["SELECT", "FROM", "AS", "JOIN", "ON"]);

function JoinExample() {
  const sql = JOIN_TEMPLATE.replace(/\$\{\d+:([^}]+)\}/g, "$1");
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

function eligible(source: DataSource): source is SavedSource {
  if (!source.id || source.id.includes(":") || source.options?.startupScript?.trim()) return false;
  if (source.driver === "postgres" || source.driver === "clickhouse") return true;
  if (source.driver === "sqlite") return !!source.file && !source.file.includes(":memory:");
  if (source.driver !== "jdbc" || vendorOf(source).id !== "duckdb") return false;
  const endpoint = source.url?.split(";", 1)[0];
  if (!endpoint?.startsWith(DUCKDB_JDBC_PREFIX)) return false;
  const path = endpoint.slice(DUCKDB_JDBC_PREFIX.length);
  return !!path && !/^[: ]|^(?:memory|md):/i.test(path) && !path.includes("://");
}

function sourceReferences(sources: SavedSource[], config: Configuration): WorkspaceSourceReference[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name || source.id,
    alias: Object.hasOwn(config.sourceAliases, source.id) ? config.sourceAliases[source.id]!.trim() : undefined,
    legacy:
      source.id === config.legacySources.left ? "left" : source.id === config.legacySources.right ? "right" : undefined,
  }));
}

function metadataTarget(source: SavedSource, database: string) {
  if (!database || database === source.database || (source.driver === "sqlite" && database === "main"))
    return source.id;
  if (source.driver === "postgres" || source.driver === "clickhouse")
    return targetOf(source.id, database, source.database ?? null);
  // A file source's completion is for its saved file only.
  return null;
}

function complete(
  bindings: () => {
    references: WorkspaceSourceReference[];
    resolve: SourceResolver;
    candidates: SavedSource[];
    configureAliases: () => void;
  },
): CompletionSource {
  return async (context) => {
    const field = context.state.selection.main;
    const selectingField =
      context.explicit &&
      !field.empty &&
      field.from === context.pos &&
      (hasNextSnippetField(context.state) || hasPrevSnippetField(context.state));
    const end = selectingField ? field.to : context.pos;
    if (end > WORKSPACE_SQL_LIMIT) return null;
    const sql = context.state.sliceDoc(0, end);
    const parsed = lex(sql, "postgres");
    const state = inLiteral(parsed, end);
    if (state === "string" || state === "comment") return null;
    const { references, resolve, candidates, configureAliases } = bindings();
    const current = projectRequest();
    const stillCurrent = () =>
      current() && !context.aborted && (!context.view || context.view.state.doc === context.state.doc);
    const target = workspaceJoinColumnTarget(sql, resolve, parsed);
    if (target) {
      const source = candidates.find((candidate) => candidate.id === target.sourceId);
      const id = source && metadataTarget(source, target.database);
      if (!id) return null;
      const catalog = useDatabase.getState().completion[id] ?? (await loadCompletion(id));
      if (!catalog || !stillCurrent()) return null;
      const updated = workspaceJoinColumnTarget(sql, bindings().resolve, parsed);
      if (
        updated?.sourceId !== target.sourceId ||
        updated.database !== target.database ||
        updated.schema !== target.schema ||
        updated.table !== target.table
      )
        return null;
      const selectingKey = selectingField && field.from === target.from;
      const column = selectingKey ? { ...target, prefix: "" } : target;
      return {
        from: target.from,
        to: selectingKey ? field.to : undefined,
        options: workspaceJoinColumnOptions(column, catalog),
        filter: false,
      };
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
      const options: Completion[] = [];
      const vendors = new Map(candidates.map((source) => [source.id, vendorOf(source).label]));
      let needsAliases = false;
      for (const ref of references) {
        const preferred = preferredReference(ref, resolve);
        if (!preferred) needsAliases = true;
        else {
          const detail = preferred === sourcePrefix(ref.name) ? vendors.get(ref.id) : ref.name;
          options.push({ label: preferred, type: "namespace", detail, boost: 5 });
        }
        if (ref.legacy && preferred !== "#" + ref.legacy && typed && ref.legacy.startsWith(typed))
          options.push({ label: "#" + ref.legacy, type: "namespace", detail: ref.name });
      }
      if (needsAliases) {
        options.push({
          label: prefix,
          displayLabel: tx("Set unique SQL aliases…"),
          type: "namespace",
          boost: -10,
          apply: configureAliases,
        });
      }
      const selectingSource = selectingField && field.from === from;
      return { from, to: selectingSource ? field.to : undefined, options, filter: !selectingSource };
    }
    const sourceToken = tokens[0]!;
    const name = identName(sourceToken);
    const quoted = sourceToken.kind === "quoted";
    const ref = resolve(name, quoted);
    if (!ref || tokens[1]!.text !== ".") return null;
    const source = candidates.find((candidate) => candidate.id === ref.id);
    const qualifier = tokens[2];
    const explicitDatabase = qualifier && qualifier.text !== "." && tokens[3]?.text === "." && tokens[5]?.text === ".";
    const database = explicitDatabase
      ? qualifier.kind === "word"
        ? qualifier.text.toLowerCase()
        : identName(qualifier)
      : "";
    const id = source && metadataTarget(source, database);
    if (!id) return null;
    const catalog = useDatabase.getState().completion[id] ?? (await loadCompletion(id));
    if (!catalog || !stillCurrent() || bindings().resolve(name, quoted)?.id !== ref.id) return null;
    // Keep the user's quoted or bare source spelling, which the resolver interpreted above.
    const sourcePath = sql.slice(from, sourceToken.to) + (database ? "." + quoteIdent(database, "postgres") : "");
    const prefixLower = prefix.toLowerCase();
    const selectingTable = selectingField && field.from === tokens[1]!.to;
    const options: Completion[] = [];
    for (const table of catalog.tables) {
      if (table.kind !== "table") continue;
      const tableName = quoteIdent(table.name, "postgres");
      const schema = quoteIdent(table.schema || catalog.defaultSchema, "postgres");
      const qualified = `${sourcePath}.${schema}.${tableName}`;
      const direct = `${sourcePath}.${tableName}`;
      const label =
        selectingTable || qualified.toLowerCase().startsWith(prefixLower)
          ? qualified
          : !database && table.schema === catalog.defaultSchema && direct.toLowerCase().startsWith(prefixLower)
            ? direct
            : null;
      if (label) {
        options.push({
          label: selectingTable ? label.slice(sourcePath.length + 1) : label,
          type: "class",
          detail: ref.name,
        });
        if (options.length === 100) break;
      }
    }
    return {
      from: selectingTable ? field.from : from,
      to: selectingTable ? field.to : undefined,
      options,
      filter: false,
    };
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
  const legacy = value.legacySources as Partial<Configuration["legacySources"]> | null | undefined;
  return {
    legacySources: {
      left: typeof legacy?.left === "string" ? legacy.left : typeof value.left === "string" ? value.left : "",
      right: typeof legacy?.right === "string" ? legacy.right : typeof value.right === "string" ? value.right : "",
    },
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
    legacySources: draft.legacySources,
    profile: draft.profile,
    sourceAliases: draft.sourceAliases,
  });
  const [settings, setSettings] = useState<Configuration | null>(null);
  const [showAliases, setShowAliases] = useState(false);
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
  const candidates = useMemo(() => sources.filter(eligible), [sources]);
  const drivers = registry.drivers?.filter((d) => d.vendor === "duckdb" && d.className === DUCKDB_JDBC_CLASS) ?? [];
  const driverFor = (id: string) =>
    id ? drivers.find((driver) => driver.id === id) : drivers.length === 1 ? drivers[0] : undefined;
  const references = useMemo(() => sourceReferences(candidates, config), [candidates, config]);
  const resolve = useMemo(() => workspaceSourceResolver(references, config), [references, config]);
  const usableReferences = useMemo(
    () => references.filter((ref) => preferredReference(ref, resolve)).length,
    [references, resolve],
  );
  const aliasError = useMemo(() => workspaceSourceAliasError(references, resolve), [references, resolve]);
  const needsAliases = usableReferences !== references.length;
  const ready = !!driverFor(config.profile) && candidates.length >= 2;
  const settingsError = useMemo(() => {
    if (!settings) return null;
    const sources = sourceReferences(candidates, settings);
    return workspaceSourceAliasError(sources, workspaceSourceResolver(sources, settings));
  }, [candidates, settings]);
  const current = useRef({
    config,
    references,
    resolve,
    candidates,
    execute: () => {},
    configureAliases: () => {},
  });
  const openSettings = (aliases = needsAliases || !!aliasError) => {
    if (running.current) return;
    setShowAliases(aliases);
    setSettings(config);
  };

  useEffect(() => {
    if (!settingsRequested || busy) return;
    const frame = requestAnimationFrame(() => {
      useDatabase.setState({ workspaceSettingsRequest: null });
      setShowAliases(needsAliases || !!aliasError);
      setSettings(config);
    });
    return () => cancelAnimationFrame(frame);
  }, [settingsRequested, busy, config, needsAliases, aliasError]);

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
      openSettings();
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
    const queries = [];
    // Validate the entire batch before the first request touches any source.
    for (const span of spans) {
      const text = state.sliceDoc(span.from, span.to);
      try {
        queries.push({ text, plan: workspaceJoinQuery(text, resolve) });
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
      for (const [index, { text, plan }] of queries.entries()) {
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
          const data = await call(commands.dbWorkspaceJoin(request, driver.id, plan));
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
    current.current = {
      config,
      references,
      resolve,
      candidates,
      execute: () => void execute(),
      configureAliases: () => openSettings(true),
    };
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

  const insertJoin = () => {
    const editor = view.current;
    if (!editor || editor.state.doc.length) return;
    snippet(JOIN_TEMPLATE)(editor, null, 0, 0);
    editor.focus();
    startCompletion(editor);
  };
  const applySettings = () => {
    if (!settings || !driverFor(settings.profile) || settingsError) return;
    const next = {
      ...settings,
      sourceAliases: Object.fromEntries(
        Object.entries(settings.sourceAliases)
          .map(([id, alias]) => [id, alias.trim()])
          .filter(([, alias]) => alias),
      ),
    };
    if (
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
  const configureLabel = t("Workspace Settings…");
  const driver = driverFor(config.profile);
  const connectionContext = driver ? `${configureLabel} · ${driver.name}` : configureLabel;
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
          icon="settings"
          aria-label={connectionContext}
          title={connectionContext}
          disabled={busy}
          onClick={() => openSettings()}
        >
          <span>{driver?.name ?? configureLabel}</span>
        </Button>
      </Toolbar>
      <div className={styles.query} data-result={hasFeedback ? "" : undefined}>
        <div className={styles.editor} ref={host} />
        {empty && (
          <div className={styles.firstRun}>
            {candidates.length < 2 ? (
              <T>Save at least two PostgreSQL, ClickHouse, SQLite, or file-backed DuckDB sources.</T>
            ) : (
              <T>Type # to choose a saved data source.</T>
            )}
            <JoinExample />
            <div className={styles.firstRunActions}>
              {usableReferences >= 2 ? (
                <Button variant="secondary" size="small" onClick={insertJoin}>
                  <T>Insert JOIN</T>
                </Button>
              ) : candidates.length < 2 ? (
                <Button variant="primary" size="small" onClick={newSource}>
                  <T>New Data Source…</T>
                </Button>
              ) : (
                <Button variant="primary" size="small" onClick={() => openSettings()}>
                  <T>Workspace Settings…</T>
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
          title={t("Workspace Settings")}
          width={480}
          onClose={() => {
            setManage(false);
            setSettings(null);
          }}
          buttons={[
            { label: "Cancel", role: "cancel" },
            {
              label: "OK",
              role: "default",
              disabled: !driverFor(settings.profile) || !!settingsError,
              onClick: applySettings,
            },
          ]}
        >
          <div className={styles.settings}>
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
            {!settings.profile && registry.drivers && !driverFor(settings.profile) && (
              <p>
                <T>Choose a DuckDB JDBC driver to run workspace SQL.</T>
              </p>
            )}
            <div className={styles.settingsActions}>
              <Button variant="ghost" disabled={registry.drivers === null} onClick={() => setManage(true)}>
                <T>Manage Drivers…</T>
              </Button>
              {registry.error && (
                <Button onClick={registry.retry}>
                  <T>Retry</T>
                </Button>
              )}
            </div>
            {candidates.length > 0 && (
              <div>
                <Button
                  variant="ghost"
                  size="small"
                  icon={showAliases ? "chevron-down" : "chevron-right"}
                  aria-expanded={showAliases}
                  aria-controls={showAliases ? `${panelId}-aliases` : undefined}
                  onClick={() => setShowAliases(!showAliases)}
                >
                  <T>SQL aliases</T>
                </Button>
                {showAliases && (
                  <div id={`${panelId}-aliases`} className={styles.aliasFields}>
                    <p>
                      <T>Use a short SQL name for a source. Leave it blank to use the connection name.</T>
                    </p>
                    {candidates.map((source) => {
                      const label = sourceLabel({ ...source, name: source.name || source.id });
                      const detail = source.file || [source.host, source.database].filter(Boolean).join(" / ");
                      const alias = Object.hasOwn(settings.sourceAliases, source.id)
                        ? settings.sourceAliases[source.id]
                        : "";
                      return (
                        <label key={source.id} className={styles.aliasField}>
                          <span className={styles.aliasName} title={detail ? `${label} · ${detail}` : label}>
                            <Icon name={vendorOf(source).icon} size={14} />
                            <span>
                              {source.name || source.id}
                              {detail && <small>{detail}</small>}
                            </span>
                          </span>
                          <Input
                            aria-label={t`SQL alias for ${label}`}
                            aria-description={detail || undefined}
                            mono
                            value={alias}
                            placeholder={source.name || source.id}
                            onChange={(event) =>
                              setSettings({
                                ...settings,
                                sourceAliases: { ...settings.sourceAliases, [source.id]: event.target.value },
                              })
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {settings.profile && registry.drivers && !driverFor(settings.profile) && (
              <p role="alert">
                <T>The saved DuckDB driver is unavailable.</T>
              </p>
            )}
            {settingsError && <p role="alert">{settingsError}</p>}
            {registry.error && <div role="alert">{registry.error}</div>}
            {candidates.length < 2 && (
              <div className={styles.settingsActions}>
                <p>
                  <T>Save at least two PostgreSQL, ClickHouse, SQLite, or file-backed DuckDB sources.</T>
                </p>
                <Button variant="secondary" size="small" onClick={newSource}>
                  <T>New Data Source…</T>
                </Button>
              </div>
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
