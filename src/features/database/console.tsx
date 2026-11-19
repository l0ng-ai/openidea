/**
 * Query console integration for SQL editors: a toolbar panel binding the file
 * to a data source (execute / stop / row limit), run feedback on the text
 * (gutter check / error, timing, error banner) and context-aware completion
 * from the introspected schema.
 */
import {
  hasNextSnippetField,
  hasPrevSnippetField,
  insertCompletionText,
  nextSnippetField,
  pickedCompletion,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  Compartment,
  EditorState,
  Facet,
  Prec,
  RangeSet,
  type Range,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  showPanel,
  showTooltip,
  type Panel,
  type Tooltip,
} from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { createRoot } from "react-dom/client";
import type { EditorDocContext } from "@/editor/api";
import { iconNode, spinnerNode } from "@/ui/iconNode";
import {
  call,
  commands,
  type DbDriver,
  type DbSessionContext,
  type DbStatementOutcome,
  type SqlStatement,
} from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { Icon, IconButton, Select, Toolbar, lazyComponent } from "@/ui";
import { useProject } from "@/platform/project";
import {
  activeSchema,
  parseSchemaTreeValue,
  schemaSwitchable,
  schemaTreeRows,
  schemaTreeValue,
  sourceIcon,
  sourceLabel,
  splitTarget,
  targetOf,
} from "./model";
import { loadSavedCatalog, offerIntrospection } from "./introspection";
import { analyze, templateContexts, valuesSlot } from "./sql/analyze";
import {
  shouldAutoCompleteSql,
  sqlCandidates,
  type CandidateKind,
  type SqlCandidate,
  type SqlCatalog,
} from "./sql/complete";
import { WHOLE_FILE, sqlSupport, type SqlText } from "./sqlSupport";
import { snowflakeLanguage } from "./sql/snowflakeHighlight";
import {
  bindConsole,
  cancelConsole,
  closeInlineResults,
  inEditorResults,
  setInEditorResults,
  consoleSchema,
  consoleSource,
  executeConsole,
  explainConsole,
  finishTransaction,
  openHistory,
  loadCompletion,
  runSql,
  listsDatabases,
  loadDatabases,
  loadSchemas,
  loadSources,
  loadTables,
  tablesKey,
  setConsoleSchema,
  setManualCommit,
  sourceById,
  useDatabase,
} from "./store";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";
import { databaseRequest, projectRequest } from "./requests";
import type { ResultTab } from "./store";

/** `templates` feature's language-data key for finer template contexts. */
const TEMPLATE_CONTEXT_KEY = "openideaTemplateContexts";

import { formatElapsed } from "./resultView";
import { SQL_LANGUAGE } from "./sqlLanguage";
export { SQL_LANGUAGE };
const ROW_LIMITS = ["100", "500", "1000", "5000", "50000"];

/** Statement outcomes of the last run, kept on the text (IDEA's gutter check / error and timing). */
interface RunMark {
  from: number;
  to: number;
  /** After the statement's `;` when it has one. */
  timingAt: number;
  error: string | null;
  ms: number | null;
}

/** The statements a running request submitted (a batch: all of them, in order). */
interface Executing {
  /** Tells this run from a later one on the same console. */
  token: number;
  /** The statements' offsets in the text sent. */
  sent: readonly { from: number; to: number }[];
  /** Where they are now. */
  spans: readonly { from: number; to: number }[];
  /** Where the elapsed time shows: after the last statement's `;`. */
  at: number;
  startedAt: number;
}

interface RunState {
  marks: readonly RunMark[];
  /** Message of the bottom error banner (`null`: hidden). */
  banner: string | null;
  executing: Executing | null;
}

const setRun = StateEffect.define<RunState>();

const runField = StateField.define<RunState>({
  create: () => ({ marks: [], banner: null, executing: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRun)) return e.value;
    if (!tr.docChanged) return value;
    // The request runs the text it was sent; edits only move where that shows.
    const ex = value.executing;
    const executing = ex && {
      ...ex,
      spans: ex.spans.map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) })),
      at: tr.changes.mapPos(ex.at),
    };
    // Editing a statement drops its mark.
    const marks: RunMark[] = [];
    for (const m of value.marks) {
      let touched = false;
      tr.changes.iterChangedRanges((a, b) => {
        if (a <= m.to && b >= m.from) touched = true;
      });
      if (!touched)
        marks.push({
          ...m,
          from: tr.changes.mapPos(m.from),
          to: tr.changes.mapPos(m.to),
          timingAt: tr.changes.mapPos(m.timingAt),
        });
    }
    return { ...value, marks, executing };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (st) => {
      const ranges = [];
      const ex = st.executing;
      for (const r of ex?.spans ?? [])
        if (r.from < r.to) ranges.push(Decoration.mark({ class: "cm-openidea-db-executing" }).range(r.from, r.to));
      if (ex) ranges.push(Decoration.widget({ widget: new ElapsedWidget(ex.startedAt), side: 1 }).range(ex.at));
      for (const m of st.marks) {
        // The new run takes the place of a statement's last outcome.
        if (ex?.spans.some((r) => r.from <= m.to && m.from <= r.to)) continue;
        if (m.error)
          ranges.push(
            Decoration.mark({ class: "cm-openidea-db-error", attributes: { title: m.error } }).range(m.from, m.to),
          );
        if (m.ms !== null)
          ranges.push(Decoration.widget({ widget: new TimingWidget(m.ms), side: 1 }).range(m.timingAt));
      }
      return Decoration.set(ranges, true);
    }),
    showPanel.from(f, (st) => (st.banner ? errorBanner(st.banner) : null)),
  ],
});

class TimingWidget extends WidgetType {
  constructor(readonly ms: number) {
    super();
  }
  eq(other: TimingWidget) {
    return other.ms === this.ms;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-openidea-db-timing";
    span.textContent = formatElapsed(this.ms);
    return span;
  }
}

/** The running time of the request, ticking until it ends. */
class ElapsedWidget extends WidgetType {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly startedAt: number) {
    super();
  }
  eq(other: ElapsedWidget) {
    return other.startedAt === this.startedAt;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-openidea-db-timing cm-openidea-db-elapsed";
    const tick = () => {
      const elapsed = formatElapsed(Date.now() - this.startedAt);
      span.textContent = tx`Executing… ${elapsed}`;
    };
    tick();
    this.timer = setInterval(tick, 100);
    return span;
  }
  destroy() {
    clearInterval(this.timer);
  }
}

class ExecutingMarker extends GutterMarker {
  eq(other: GutterMarker) {
    return other instanceof ExecutingMarker;
  }
  toDOM() {
    const el = spinnerNode(12, "cm-openidea-db-run-executing");
    el.title = tx("Executing");
    return el;
  }
}

class RunMarker extends GutterMarker {
  constructor(readonly error: string | null) {
    super();
  }
  eq(other: RunMarker) {
    return other.error === this.error;
  }
  toDOM() {
    const el = iconNode(
      this.error ? "error" : "check",
      14,
      this.error ? "cm-openidea-db-run-error" : "cm-openidea-db-run-ok",
    );
    el.title = this.error ?? "Executed";
    return el;
  }
}

const runGutter = gutter({
  class: "cm-openidea-db-gutter",
  markers: (view) => {
    const st = view.state.field(runField);
    const doc = view.state.doc;
    const ex = st.executing;
    const ranges: Range<GutterMarker>[] = st.marks
      .filter((m) => m.from <= doc.length && !ex?.spans.some((r) => r.from <= m.to && m.from <= r.to))
      .map((m) => new RunMarker(m.error).range(doc.lineAt(m.from).from));
    const first = ex?.spans[0];
    if (first && first.from <= doc.length) ranges.push(new ExecutingMarker().range(doc.lineAt(first.from).from));
    return RangeSet.of(ranges, true);
  },
});

function errorBanner(message: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "cm-openidea-db-banner";
    dom.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.className = "cm-openidea-db-banner-text";
    text.textContent = message;
    text.title = message;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cm-openidea-db-banner-close";
    close.setAttribute("aria-label", "Close");
    close.appendChild(iconNode("close", 14));
    close.onclick = () => view.dispatch({ effects: setRun.of({ ...view.state.field(runField), banner: null }) });
    dom.append(text, close);
    return { dom, top: false };
  };
}

/** Marks the statements that ran: gutter check or error, timing, the error banner. */
export function markOutcomes(view: EditorView, outcomes: readonly DbStatementOutcome[]) {
  const len = view.state.doc.length;
  const marks = outcomes
    .filter((o) => o.statement.to <= len && o.statement.from < o.statement.to)
    .map((o) => ({
      from: o.statement.from,
      to: o.statement.to,
      timingAt: view.state.sliceDoc(o.statement.to, o.statement.to + 1) === ";" ? o.statement.to + 1 : o.statement.to,
      error: o.error ?? null,
      ms: o.result?.elapsedMs ?? null,
    }));
  const failed = outcomes.find((o) => o.error);
  const name = failed ? (sourceById(consoleSource(view.state.facet(consolePath)))?.name ?? "") : "";
  view.dispatch({
    effects: setRun.of({ ...view.state.field(runField), marks, banner: failed ? `[${name}] ${failed.error}` : null }),
  });
}

let nextExecution = 0;

/** `outcomes` at where their statements are now, when the text was edited while they ran. */
function placed(
  executing: Executing | null,
  token: number,
  outcomes: readonly DbStatementOutcome[],
): readonly DbStatementOutcome[] {
  if (executing?.token !== token) return outcomes;
  return outcomes.map((o) => {
    const i = executing.sent.findIndex((r) => r.from === o.statement.from && r.to === o.statement.to);
    const now = executing.spans[i];
    return now ? { ...o, statement: { ...o.statement, from: now.from, to: now.to } } : o;
  });
}

/** Runs `from`–`to` of `view`, showing the submitted statements as executing until the request ends. */
async function executeRange(view: EditorView, path: string, from: number, to: number) {
  const token = ++nextExecution;
  const sent = view.state.doc;
  const start = (statements: readonly SqlStatement[]) => {
    // The offsets are into the text sent; an edit since (while asking for parameters) leaves them unplaced.
    if (view.state.doc !== sent) return;
    const spans = statements.map((st) => ({ from: st.from, to: st.to }));
    const last = spans.at(-1);
    if (!last) return;
    const at = view.state.sliceDoc(last.to, last.to + 1) === ";" ? last.to + 1 : last.to;
    const executing = { token, sent: spans, spans, at, startedAt: Date.now() };
    view.dispatch({ effects: setRun.of({ ...view.state.field(runField), executing }) });
  };
  try {
    const outcomes = await executeConsole(path, sent.toString(), from, to, start);
    if (outcomes.length) markOutcomes(view, placed(view.state.field(runField).executing, token, outcomes));
  } finally {
    const st = view.state.field(runField, false);
    if (st?.executing?.token === token) view.dispatch({ effects: setRun.of({ ...st, executing: null }) });
  }
}

/** Runs the statement at the caret (or the selected ones) of `view`. */
export async function executeInView(view: EditorView, path: string) {
  const sel = view.state.selection.main;
  await executeRange(view, path, sel.from, sel.to);
}

/** Runs every statement of `view`, in order (stops at the first that fails). */
export async function executeScriptInView(view: EditorView, path: string) {
  await executeRange(view, path, 0, view.state.doc.length);
}

/** Explain Plan of the statement at the caret (or the first selected one) of `view`. */
export async function explainInView(view: EditorView, path: string) {
  const sel = view.state.selection.main;
  await explainConsole(path, view.state.doc.toString(), sel.from, sel.to);
}

const consolePath = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });

/** An in-editor result and the statement it shows under (mapped through edits). */
interface InlineAnchor {
  id: number;
  from: number;
  to: number;
}

/**
 * Where each in-editor result's statement is now and how tall the result is, by result id:
 * a console's view can be rebuilt (closed and reopened), and its results go back where they were.
 */
const anchors = new Map<number, { from: number; to: number }>();
const heights = new Map<number, number>();
const MAX_FIT_HEIGHT = 320;
const MIN_HEIGHT = 96;

/** Toolbar, notice, header row, the rows and room for the floating pager, up to `MAX_FIT_HEIGHT`. */
function fitHeight(tab: ResultTab | undefined): number {
  const rows = tab?.outcome.result?.rows.length ?? 0;
  return Math.max(MIN_HEIGHT, Math.min(MAX_FIT_HEIGHT, 40 + 24 + 24 + Math.max(rows, 1) * 24 + 56));
}

const setInline = StateEffect.define<InlineAnchor[]>();
/** An in-editor result was resized: its widget is redrawn so the editor measures it again. */
const resized = StateEffect.define<null>();

function anchorOf(tab: ResultTab): InlineAnchor {
  return { id: tab.id, ...(anchors.get(tab.id) ?? { from: tab.outcome.statement.from, to: tab.outcome.statement.to }) };
}

const inlineField = StateField.define<readonly InlineAnchor[]>({
  create: (state) => {
    const path = state.facet(consolePath);
    return useDatabase
      .getState()
      .inline.filter((t) => t.path === path)
      .map(anchorOf)
      .filter((a) => a.to <= state.doc.length);
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setInline)) value = e.value;
      else if (e.is(resized)) value = [...value];
    }
    if (!tr.docChanged) return value;
    const next: InlineAnchor[] = [];
    for (const a of value) {
      const from = tr.changes.mapPos(a.from, 1);
      const to = tr.changes.mapPos(a.to, -1);
      // The statement was deleted: so is its result (the store drops it in `syncInline`).
      if (to <= from) continue;
      anchors.set(a.id, { from, to });
      next.push({ id: a.id, from, to });
    }
    return next;
  },
  // Under the statement's last line.
  provide: (f) =>
    EditorView.decorations.compute([f], (state) =>
      Decoration.set(
        state
          .field(f)
          .map((a) =>
            Decoration.widget({ widget: new InlineResultWidget(a.id, heightOf(a.id)), block: true, side: 1 }).range(
              state.doc.lineAt(a.to).to,
            ),
          ),
        true,
      ),
    ),
});

/**
 * Keeps the view's in-editor results in step with the store: a run's new results show under
 * their statements (replacing what those statements showed before), closed ones go away.
 */
const syncInline = ViewPlugin.define((view) => {
  const path = view.state.facet(consolePath);
  let destroyed = false;
  const sync = () => {
    if (destroyed) return;
    const current = view.state.field(inlineField);
    const tabs = useDatabase.getState().inline.filter((t) => t.path === path);
    const ids = new Set(tabs.map((t) => t.id));
    const known = new Set(current.map((a) => a.id));
    const len = view.state.doc.length;
    const added = tabs
      .filter((t) => !known.has(t.id))
      .map(anchorOf)
      .filter((a) => a.to <= len);
    const overlaps = (a: InlineAnchor) => added.some((b) => b.from < a.to && a.from < b.to);
    const replaced = current.filter((a) => ids.has(a.id) && overlaps(a)).map((a) => a.id);
    const kept = current.filter((a) => ids.has(a.id) && !replaced.includes(a.id));
    for (const a of current)
      if (!ids.has(a.id)) {
        anchors.delete(a.id);
        heights.delete(a.id);
      }
    if (!added.length && kept.length === current.length) return;
    for (const a of added) anchors.set(a.id, { from: a.from, to: a.to });
    view.dispatch({ effects: setInline.of([...kept, ...added].sort((a, b) => a.to - b.to || a.id - b.id)) });
    if (replaced.length) closeInlineResults(replaced);
  };
  let shown = view.state.field(inlineField);
  const stop = useDatabase.subscribe((s, prev) => {
    if (s.inline !== prev.inline) queueMicrotask(sync);
  });
  queueMicrotask(sync);
  return {
    // Results whose statements were deleted go too.
    update(u) {
      const next = u.state.field(inlineField);
      if (next === shown) return;
      const gone = shown.filter((a) => !next.some((b) => b.id === a.id)).map((a) => a.id);
      shown = next;
      if (gone.length && u.docChanged) queueMicrotask(() => closeInlineResults(gone));
    },
    destroy: () => {
      destroyed = true;
      stop();
    },
  };
});

function heightOf(id: number): number {
  return heights.get(id) ?? fitHeight(useDatabase.getState().inline.find((r) => r.id === id));
}

const InlineGrid = lazyComponent(() => import("./ResultsView").then((m) => m.Result));

function InlineResult({ id, view }: { id: number; view: EditorView }) {
  const tab = useDatabase((s) => s.inline.find((r) => r.id === id));
  const [height, setHeight] = useState(() => heightOf(id));
  const drag = useRef<{ y: number; height: number } | null>(null);
  const measured = useRef(height);
  useEffect(() => {
    if (measured.current === height) return;
    measured.current = height;
    view.dispatch({ effects: resized.of(null) });
  }, [height, view]);
  if (!tab) return null;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = Math.max(MIN_HEIGHT, Math.round(drag.current.height + e.clientY - drag.current.y));
    heights.set(id, next);
    setHeight(next);
  };
  return (
    <div className={styles.inlineResult} style={{ height }}>
      <InlineGrid tab={tab} onClose={() => closeInlineResults([id])} />
      <div
        className={styles.inlineResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label={tx("Resize")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
      />
    </div>
  );
}

const inlineRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>();

class InlineResultWidget extends WidgetType {
  constructor(
    readonly id: number,
    readonly height: number,
  ) {
    super();
  }
  eq(other: InlineResultWidget) {
    return other.id === this.id && other.height === this.height;
  }
  /** A resized result keeps its DOM (and grid state); only the editor's measurement changes. */
  updateDOM(dom: HTMLElement) {
    return dom.dataset.result === String(this.id);
  }
  get estimatedHeight() {
    return this.height + 12;
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-openidea-db-inline";
    dom.contentEditable = "false";
    dom.dataset.result = String(this.id);
    const root = createRoot(dom);
    inlineRoots.set(dom, root);
    root.render(<InlineResult id={this.id} view={view} />);
    return dom;
  }
  destroy(dom: HTMLElement) {
    const root = inlineRoots.get(dom);
    inlineRoots.delete(dom);
    queueMicrotask(() => root?.unmount());
  }
  ignoreEvent() {
    return true;
  }
}

function ConsoleBar({ path, view }: { path: string; view: EditorView }) {
  const sources = useDatabase((s) => s.sources);
  const loaded = useDatabase((s) => s.loaded);
  const bound = useDatabase(() => consoleSource(path));
  const running = useDatabase((s) => !!s.running[path]);
  const maxRows = useDatabase((s) => s.maxRows);
  const manual = useDatabase((s) => !!bound && s.manualCommit.has(bound));
  const pending = useDatabase((s) => !!bound && s.pendingTx.has(bound));
  const inEditor = useProject((s) => inEditorResults(s.settings));
  // SQL resolution scopes in the settings can move the console to another data source.
  useProject((s) => s.settings);
  const boundId = bound ? splitTarget(bound).id : null;
  const driver = sources.find((s) => s.id === boundId)?.driver;
  const jdbc = driver === "jdbc";
  const supportsTransactions = driver !== "clickhouse" && !jdbc;
  const switchable = schemaSwitchable(driver);
  // The console's active schema: its pick, else the connection's default (`completion.defaultSchema`).
  const pickedSchema = useDatabase((s) => s.consoleSchemas[path]);
  const defaultSchema = useDatabase((s) => (bound ? s.completion[bound]?.defaultSchema : undefined));
  const schemaList = useDatabase((s) => (bound ? s.schemas[bound] : undefined));
  const schema = activeSchema(pickedSchema, defaultSchema);
  useEffect(() => {
    if (boundId && listsDatabases(sourceById(boundId)) && !useDatabase.getState().databases[boundId])
      void loadDatabases(boundId);
  }, [boundId]);
  // Loads the list again after a refresh drops it.
  const schemasMissing = !schemaList;
  useEffect(() => {
    if (bound && switchable && schemasMissing) void loadSchemas(bound);
  }, [bound, switchable, schemasMissing]);
  const schemaOptions = useMemo(() => {
    if (!switchable) return [];
    const names = schemaList?.status === "ok" ? schemaList.value : [];
    const out = names.map((n) => ({ value: n, label: n, icon: "db-schema" }));
    // The connection's default is offered even before its schema list loads.
    if (defaultSchema && !names.includes(defaultSchema))
      out.unshift({ value: defaultSchema, label: defaultSchema, icon: "db-schema" });
    return out;
  }, [switchable, schemaList, defaultSchema]);
  // IDEA's order: pick the data source, then a database and a schema in it.
  const sourceOptions = useMemo(
    () =>
      sources.map((s) => ({
        value: s.id ?? "",
        label: s.name ?? "",
        verbatim: true,
        detail: sourceLabel(s).slice((s.name ?? "").length + 1),
        icon: sourceIcon(s),
      })),
    [sources],
  );
  useEffect(() => {
    if (!loaded) void loadSources();
  }, [loaded]);
  useEffect(() => {
    if (bound) void loadCompletion(bound);
  }, [bound]);
  return (
    <Toolbar className={styles.consoleBar} aria-label="Query Console">
      <IconButton
        icon="run"
        title="Execute"
        shortcut={shortcutLabel("db.execute")}
        disabled={!bound || running}
        onClick={() => void executeInView(view, path)}
      />
      <IconButton
        icon="gutter-run-all"
        title="Execute Script"
        disabled={!bound || running}
        onClick={() => void executeScriptInView(view, path)}
      />
      <span className={styles.toolbarSeparator} />
      <IconButton icon="history" title="Browse Query History" disabled={!bound} onClick={() => openHistory(path)} />
      {!jdbc && (
        <IconButton
          icon="db-plan"
          title="Explain Plan"
          disabled={!bound || running}
          onClick={() => void explainInView(view, path)}
        />
      )}
      <IconButton
        icon="db-in-editor-results"
        title="In-Editor Results"
        aria-pressed={inEditor}
        onClick={() => void setInEditorResults(!inEditor)}
      />
      <span className={styles.toolbarSeparator} />
      {supportsTransactions && (
        <Select
          variant="ghost"
          aria-label="Transaction mode"
          value={manual ? "manual" : "auto"}
          options={[
            { value: "auto", label: "Tx: Auto" },
            { value: "manual", label: "Tx: Manual" },
          ]}
          onChange={(v) => bound && void setManualCommit(bound, v === "manual")}
          disabled={!bound}
        />
      )}
      {supportsTransactions && manual && (
        <>
          <IconButton
            icon="commit"
            title="Commit"
            disabled={!pending || running}
            onClick={() => bound && void finishTransaction(bound, true)}
          />
          <IconButton
            icon="revert"
            title="Roll Back"
            disabled={!pending || running}
            onClick={() => bound && void finishTransaction(bound, false)}
          />
        </>
      )}
      <IconButton
        icon="stop"
        title="Cancel Running Statement"
        disabled={!running}
        onClick={() => cancelConsole(path)}
      />
      <span className={styles.toolbarSeparator} />
      <Select
        variant="ghost"
        aria-label="Row limit"
        value={String(maxRows)}
        options={ROW_LIMITS.map((v) => ({ value: v, label: tx`${Number(v).toLocaleString("en")} rows` }))}
        onChange={(v) => useDatabase.setState({ maxRows: Number(v) })}
      />
      <span className={styles.spacer} />
      {bound && driver === "snowflake" && <SnowflakeSession target={bound} idle={!running} />}
      <Select
        variant="ghost"
        aria-label="Data source"
        value={boundId}
        placeholder={sources.length ? "<data source>" : "None configured"}
        options={sourceOptions}
        searchable
        onChange={(id) => id !== boundId && bindConsole(path, id)}
        disabled={!sources.length}
      />
      {bound && boundId && switchable && listsDatabases(sourceById(boundId)) ? (
        <DatabaseSchemaSwitcher path={path} bound={bound} sourceId={boundId} schema={schema} />
      ) : (
        switchable && (
          <Select
            variant="ghost"
            aria-label="Schema"
            value={schema || null}
            placeholder="<schema>"
            options={schemaOptions}
            searchable
            onChange={(v) => setConsoleSchema(path, v)}
            disabled={!bound}
          />
        )
      )}
      {driver === "sqlite" && (
        <span className={styles.consoleSchema} title={tx("Schema")}>
          <Icon name="db-schema" size={14} />
          {schema || "main"}
        </span>
      )}
    </Toolbar>
  );
}

/**
 * The `database.schema` switcher of a data source that shows several databases (IDEA's): a tree of
 * its databases, expanding to their schemas. Choosing a schema in another database moves the console there.
 */
function DatabaseSchemaSwitcher({
  path,
  bound,
  sourceId,
  schema,
}: {
  path: string;
  bound: string;
  sourceId: string;
  schema: string;
}) {
  const listed = useDatabase((s) => s.databases[sourceId]);
  const schemas = useDatabase((s) => s.schemas);
  const read = useDatabase((s) => s.catalogs[sourceId]?.databases);
  const current = listed?.status === "ok" ? listed.value.current : null;
  const database = splitTarget(bound).database ?? current;
  // The console's database starts expanded, again whenever the console moves to another one.
  const [opened, setOpened] = useState<{ at: string | null; open: ReadonlySet<string> } | null>(null);
  const expanded = useMemo(
    () => (opened && opened.at === database ? opened.open : new Set(database ? [database] : [])),
    [opened, database],
  );
  const targetFor = (name: string) => (name === database ? bound : targetOf(sourceId, name, current));
  // Schemas of expanded databases that are not read yet, or were dropped by a refresh.
  const missing = [...expanded]
    .filter((name) => !read?.[name] && !schemas[targetFor(name)])
    .map(targetFor)
    .join("\n");
  useEffect(() => {
    for (const target of missing ? missing.split("\n") : []) void loadSchemas(target);
  }, [missing]);
  const rows = useMemo(() => {
    const names = listed?.status === "ok" ? [...listed.value.names] : [];
    // The console's database is offered even before the list loads.
    if (database && !names.includes(database)) names.unshift(database);
    return schemaTreeRows(names, expanded, (name) => {
      const target = name === database ? bound : targetOf(sourceId, name, current);
      const list = schemas[target];
      if (list?.status === "ok") return list.value;
      if (read?.[name]) return read[name].map((s) => s.name);
      return list?.status === "error" ? { error: list.message } : undefined;
    });
  }, [listed, database, expanded, schemas, read, bound, sourceId, current]);
  const value = database && schema ? schemaTreeValue(database, schema) : null;
  return (
    <Select
      variant="ghost"
      aria-label="Database and schema"
      value={value}
      placeholder="<schema>"
      options={rows}
      searchable
      renderValue={() => (database ? (schema ? `${database}.${schema}` : database) : tx("<schema>"))}
      keepOpen={(v) => parseSchemaTreeValue(v).schema === null}
      onChange={(v) => {
        const pick = parseSchemaTreeValue(v);
        if (pick.schema === null) {
          const next = new Set(expanded);
          if (!next.delete(pick.database)) {
            next.add(pick.database);
            // Expanding again retries a database whose schemas could not be read.
            const target = targetFor(pick.database);
            if (useDatabase.getState().schemas[target]?.status === "error") void loadSchemas(target);
          }
          setOpened({ at: database, open: next });
          return;
        }
        const target = targetFor(pick.database);
        if (target !== bound) bindConsole(path, target);
        setConsoleSchema(path, pick.schema);
      }}
    />
  );
}

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Warehouse and role of a Snowflake data source's session (its consoles share them). Read
 * once connected and after each run, since `USE WAREHOUSE` / `USE ROLE` in a console moves them too.
 */
function SnowflakeSession({ target, idle }: { target: string; idle: boolean }) {
  const connected = useDatabase((s) => s.connected.has(target));
  const [state, setState] = useState<DbSessionContext>({
    warehouse: "",
    role: "",
    warehouses: [],
    roles: [],
  });
  useEffect(() => {
    // Completion has the saved catalog before the first connect; a stale one is read again after it.
    void loadSavedCatalog(target);
    if (connected) void offerIntrospection(target);
  }, [connected, target]);
  useEffect(() => {
    if (!connected || !idle) return;
    let stale = false;
    call(commands.dbSessionContext(target))
      .then((context) => {
        if (!stale) setState(context);
      })
      // Not connected any more, or no privilege: the pickers keep what they showed.
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [target, connected, idle]);
  if (!connected) return null;
  const use = async (what: "WAREHOUSE" | "ROLE", name: string) => {
    if (await runSql(target, [`USE ${what} ${quoted(name)}`]))
      setState((s) => (what === "WAREHOUSE" ? { ...s, warehouse: name } : { ...s, role: name }));
  };
  const options = (names: string[], current: string) =>
    [...new Set(current ? [current, ...names] : names)].map((n) => ({ value: n, label: n }));
  return (
    <>
      <Select
        variant="ghost"
        aria-label="Warehouse"
        value={state.warehouse || null}
        placeholder="<warehouse>"
        options={options(state.warehouses, state.warehouse)}
        searchable={state.warehouses.length > 10}
        onChange={(v) => void use("WAREHOUSE", v)}
        disabled={!idle}
      />
      <Select
        variant="ghost"
        aria-label="Role"
        value={state.role || null}
        placeholder="<role>"
        options={options(state.roles, state.role)}
        searchable={state.roles.length > 10}
        onChange={(v) => void use("ROLE", v)}
        disabled={!idle}
      />
    </>
  );
}

function consolePanel(path: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    const root = createRoot(dom);
    root.render(<ConsoleBar path={path} view={view} />);
    return { dom, top: true, destroy: () => queueMicrotask(() => root.unmount()) };
  };
}

const ICONS: Record<CandidateKind, string | null> = {
  table: "db-table",
  view: "db-view",
  column: "db-column",
  columns: "db-columns",
  keyword: null,
  function: "symbol-function",
  schema: "db-schema",
  alias: null,
  join: "db-column-fk",
  type: null,
};

function iconOf(c: SqlCandidate): string | null {
  if (c.kind !== "column") return ICONS[c.kind];
  return c.primaryKey ? "db-column-key" : c.foreignKey ? "db-column-fk" : "db-column";
}

function docNode(text: string): Node {
  const pre = document.createElement("pre");
  pre.className = "cm-openidea-db-doc";
  pre.textContent = text;
  return pre;
}

function applyCandidate(c: SqlCandidate, driver: DbDriver, sql: SqlText) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    // A selected template placeholder is replaced, as CodeMirror's own string completions do.
    const sel = view.state.selection.main;
    if (to === sel.from) to = sel.to;
    if (c.snippet) {
      snippet(c.snippet)(view, completion, from, to);
      return;
    }
    const text = c.insert ?? c.label;
    if (!c.addFrom) {
      // Every cursor, so a template variable used twice (`$alias$`) follows along.
      view.dispatch({
        ...insertCompletionText(view.state, text, from, to),
        userEvent: "input.complete",
        annotations: pickedCompletion.of(completion),
      });
      if (c.retrigger) setTimeout(() => startCompletion(view), 0);
      else finishTemplateField(view);
      return;
    }
    const changes: Array<{ from: number; to?: number; insert: string }> = [{ from, to, insert: text }];
    // Re-read the statement as it is now: the user may have typed on since the popup opened.
    const a = analyze(sql.text(view.state), to, driver);
    if (a.fromInsert !== null) {
      const clause = ` ${a.lowerKeywords ? "from" : "FROM"} ${c.addFrom}`;
      if (a.fromInsert <= to) changes[0]!.insert += clause;
      else changes.push({ from: a.fromInsert, insert: clause });
    }
    view.dispatch({
      changes,
      selection: { anchor: from + text.length },
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
    });
  };
}

/** Picking an item for a template field moves on to the next field, as in IDEA. */
function finishTemplateField(view: EditorView) {
  if (hasNextSnippetField(view.state)) nextSnippetField(view);
}

/**
 * Context-aware SQL completion against the bound data source's schema (see
 * `sql/analyze` and `sql/complete`); keywords and functions without one.
 */
/**
 * The databases of Snowflake data source `id` with their loaded schemas and tables, so
 * completion can follow `database.schema.table` beyond the console's own database.
 */
function catalogOf(id: string): SqlCatalog | undefined {
  const st = useDatabase.getState();
  const { id: sourceId, database: bound } = splitTarget(id);
  const listed = st.databases[sourceId];
  const dbs = listed?.status === "ok" ? listed.value : null;
  // What introspection read comes first (it is there before connecting); a database it has not
  // reached falls back to what the tree loaded.
  const read = st.catalogs[sourceId]?.databases ?? {};
  if (!dbs && !Object.keys(read).length) return undefined;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const target = (database: string) => (dbs ? targetOf(sourceId, database, dbs.current) : null);
  const schemas = (database: string) => {
    if (read[database]) return read[database].map((s) => s.name);
    const at = target(database);
    const list = at ? st.schemas[at] : undefined;
    return list?.status === "ok" ? list.value : null;
  };
  const current = bound ?? dbs?.current ?? "";
  return {
    databases: dbs?.names ?? Object.keys(read),
    schemas,
    tables: (database, schema) => {
      const known = read[database]?.find((s) => same(s.name, schema));
      if (known) return known.tables.map((t) => ({ name: t.name, view: t.kind !== "table" }));
      const exact = schemas(database)?.find((s) => same(s, schema));
      const at = target(database);
      const list = exact && at ? st.tables[tablesKey(at, exact)] : undefined;
      return list?.status === "ok" ? list.value.map((t) => ({ name: t.name, view: t.kind !== "table" })) : null;
    },
    search: (prefix, limit) => {
      const wanted = prefix.toLowerCase();
      const found: Array<{ database: string; schema: string; name: string; view: boolean }> = [];
      for (const [database, list] of Object.entries(read)) {
        // The console's own database is in the schema model already.
        if (same(database, current)) continue;
        for (const schema of list)
          for (const t of schema.tables) {
            if (!t.name.toLowerCase().startsWith(wanted)) continue;
            found.push({ database, schema: schema.name, name: t.name, view: t.kind !== "table" });
            if (found.length >= limit) return found;
          }
      }
      return found;
    },
  };
}

/** Loads what `database.` / `database.schema.` at the caret needs before it is completed. */
async function loadQualified(id: string, qualifier: readonly string[]): Promise<void> {
  const current = databaseRequest(id);
  const sourceId = splitTarget(id).id;
  // Introspection has it: nothing to load (and no reason to connect for it).
  const wanted = (qualifier[0] ?? "").toLowerCase();
  const read = useDatabase.getState().catalogs[sourceId]?.databases ?? {};
  if (Object.keys(read).some((d) => d.toLowerCase() === wanted)) return;
  if (!useDatabase.getState().databases[sourceId]) await loadDatabases(sourceId);
  if (!current()) return;
  const dbs = useDatabase.getState().databases[sourceId];
  if (dbs?.status !== "ok") return;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const database = dbs.value.names.find((d) => same(d, qualifier[0] ?? ""));
  if (!database) return;
  if (useDatabase.getState().catalogs[sourceId]?.databases[database]) return;
  const target = targetOf(sourceId, database, dbs.value.current);
  if (!useDatabase.getState().schemas[target]) await loadSchemas(target);
  if (!current()) return;
  if (qualifier.length < 2) return;
  const list = useDatabase.getState().schemas[target];
  const schema = list?.status === "ok" ? list.value.find((s) => same(s, qualifier[1]!)) : undefined;
  if (schema && !useDatabase.getState().tables[tablesKey(target, schema)]) await loadTables(target, schema);
}

/** SQL completion in `path`, where `sql` says the SQL is (the whole file, or a mapper's statements). */
export function completionSource(path: string, sql: SqlText = WHOLE_FILE): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (sql.at && !sql.at(ctx.state, ctx.pos)) return null;
    const id = consoleSource(path);
    const current = id ? databaseRequest(id) : projectRequest();
    const source = sourceById(id);
    const driver: DbDriver = source?.driver ?? "sqlite";
    const model = id ? (useDatabase.getState().completion[id] ?? null) : null;
    if (id && !model) void loadCompletion(id);
    // Unqualified names resolve in the console's active schema (IDEA's schema dropdown).
    const schema = consoleSchema(path);
    const scoped = model && schema ? { ...model, defaultSchema: schema } : model;
    // A selected template placeholder (`alias`) is about to be replaced: analyze without it.
    const sel = ctx.state.selection.main;
    const placeholder = !sel.empty && (ctx.pos === sel.from || ctx.pos === sel.to);
    const doc = sql.text(ctx.state);
    const analysis = placeholder
      ? analyze(doc.slice(0, sel.from) + doc.slice(sel.to), sel.from, driver)
      : analyze(doc, ctx.pos, driver);
    if (!ctx.explicit && !shouldAutoCompleteSql(analysis)) return null;
    const cataloged = driver === "snowflake" && !!id;
    if (cataloged && analysis.qualifier?.length) {
      await loadQualified(id, analysis.qualifier).catch(() => {});
      if (ctx.aborted || !current()) return null;
    }
    const candidates = sqlCandidates({
      model: scoped,
      analysis,
      driver,
      sourceName: source?.name ?? undefined,
      catalog: cataloged ? catalogOf(id) : undefined,
    });
    if (!candidates.length) return null;
    return {
      from: analysis.prefix.from,
      options: candidates.map((c) => ({
        label: c.label,
        detail: c.tail,
        typeText: c.type,
        icon: iconOf(c),
        type: c.kind === "keyword" ? "keyword" : c.kind,
        boost: Math.max(-99, Math.min(99, c.boost)),
        info: c.doc ? () => docNode(c.doc!) : undefined,
        apply: applyCandidate(c, driver, sql),
      })),
      validFor: /^[\p{L}\p{N}_$]*$/u,
    };
  };
}

const noKeywords: CompletionSource = (ctx) => ({ from: ctx.pos, options: [] });

function driverOf(path: string): DbDriver {
  return sourceById(consoleSource(path))?.driver ?? "sqlite";
}

/**
 * Syntax colours of the bound data source's dialect, over the editor's standard SQL mode.
 * Follows the binding: a console moved to another data source is coloured for that one.
 */
function dialectColours(path: string): Extension {
  const slot = new Compartment();
  const colours = (driver: DbDriver): Extension =>
    driver === "snowflake" ? Prec.high(snowflakeLanguage().extension) : [];
  const initial = driverOf(path);
  return [
    slot.of(colours(initial)),
    ViewPlugin.define((view) => {
      let shown = initial;
      const stop = useDatabase.subscribe(() => {
        const driver = driverOf(path);
        if (driver === shown) return;
        shown = driver;
        view.dispatch({ effects: slot.reconfigure(colours(driver)) });
      });
      return { destroy: stop };
    }),
  ];
}

/** Live template contexts at a position (`sql-statement` / `sql-query` / `sql-code`). */
function templateContextsAt(path: string) {
  return (state: EditorState, pos: number): readonly string[] =>
    templateContexts(analyze(state.doc.toString(), pos, driverOf(path)));
}

/**
 * A template ending right after a qualifier (`selw`: `where o.|`) opens column
 * completion there; its other fields complete through the templates feature.
 */
const completeAfterTemplate = EditorView.updateListener.of((u) => {
  if (u.docChanged || !u.selectionSet || u.transactions.some((tr) => tr.isUserEvent("select"))) return;
  const active = (s: EditorState) => hasNextSnippetField(s) || hasPrevSnippetField(s);
  if (!active(u.startState) || active(u.state)) return;
  const head = u.state.selection.main.head;
  if (!u.state.selection.main.empty || u.state.sliceDoc(head - 1, head) !== ".") return;
  setTimeout(() => {
    if (u.view.state.selection === u.state.selection) startCompletion(u.view);
  }, 0);
});

/** IDEA's parameter info inside `VALUES (…)`: the target columns, the current one in bold. */
function valuesInfo(path: string) {
  const compute = (state: EditorState): Tooltip | null => {
    const sel = state.selection.main;
    if (!sel.empty) return null;
    const id = consoleSource(path);
    const slot = valuesSlot(state.doc.toString(), sel.head, driverOf(path));
    if (!slot) return null;
    const table = id
      ? useDatabase
          .getState()
          .completion[id]?.tables.find((t) => t.name.toLowerCase() === slot.target.name.toLowerCase())
      : undefined;
    const names = slot.columns ?? table?.columns.map((c) => c.name) ?? [];
    if (!names.length) return null;
    const typeOf = (n: string) => table?.columns.find((c) => c.name.toLowerCase() === n.toLowerCase())?.dataType;
    return {
      pos: sel.head,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-openidea-db-params";
        names.forEach((n, i) => {
          if (i) dom.append(", ");
          const span = document.createElement("span");
          if (i === slot.index) span.className = "cm-openidea-db-param-current";
          const type = typeOf(n);
          span.textContent = type ? `${n}:${type}` : n;
          dom.append(span);
        });
        return { dom };
      },
    };
  };
  return StateField.define<Tooltip | null>({
    create: compute,
    update: (value, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : value),
    provide: (f) => showTooltip.from(f),
  });
}

export function consoleExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== SQL_LANGUAGE || ctx.virtual || ctx.readOnly) return [];
  return [
    consolePath.of(ctx.path),
    runField,
    runGutter,
    inlineField,
    syncInline,
    showPanel.of(consolePanel(ctx.path)),
    EditorState.languageData.of(() => [
      { openideaCompletion: completionSource(ctx.path), [TEMPLATE_CONTEXT_KEY]: templateContextsAt(ctx.path) },
    ]),
    completeAfterTemplate,
    valuesInfo(ctx.path),
    sqlSupport(ctx.path),
    dialectColours(ctx.path),
    // The grammar's keyword list would duplicate ours (it is the fallback without a language server).
    Prec.highest(EditorState.languageData.of(() => [{ autocomplete: noKeywords }])),
  ];
}
