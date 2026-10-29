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
import { EditorState, Facet, Prec, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  showPanel,
  showTooltip,
  type Panel,
  type Tooltip,
} from "@codemirror/view";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { EditorDocContext } from "@/editor/api";
import { iconNode } from "@/editor/lsp/iconMarkup";
import type { DbDriver, DbStatementOutcome } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { IconButton, Select } from "@/ui";
import { sourceLabel, splitTarget, targetOf } from "./model";
import { analyze, templateContexts, valuesSlot } from "./sql/analyze";
import { shouldAutoCompleteSql, sqlCandidates, type CandidateKind, type SqlCandidate } from "./sql/complete";
import { sqlSupport } from "./sqlSupport";
import {
  bindConsole,
  cancelConsole,
  consoleSource,
  executeConsole,
  explainConsole,
  finishTransaction,
  openHistory,
  loadCompletion,
  listsDatabases,
  loadDatabases,
  loadSources,
  setManualCommit,
  sourceById,
  targetLabel,
  useDatabase,
} from "./store";
import styles from "./Database.module.css";
import { tx } from "@/platform/i18n";

/** `templates` feature's language-data key for finer template contexts. */
const TEMPLATE_CONTEXT_KEY = "openideaTemplateContexts";

export const SQL_LANGUAGE = "sql";
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

interface RunState {
  marks: readonly RunMark[];
  /** Message of the bottom error banner (`null`: hidden). */
  banner: string | null;
}

const setRun = StateEffect.define<RunState>();

const runField = StateField.define<RunState>({
  create: () => ({ marks: [], banner: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRun)) return e.value;
    if (!tr.docChanged) return value;
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
    return { ...value, marks };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (st) => {
      const ranges = [];
      for (const m of st.marks) {
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
    span.textContent = this.ms < 1000 ? `${Math.round(this.ms)} ms` : `${(this.ms / 1000).toFixed(1)} s`;
    return span;
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
    const ranges = st.marks
      .filter((m) => m.from <= doc.length)
      .map((m) => new RunMarker(m.error).range(doc.lineAt(m.from).from));
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
  view.dispatch({ effects: setRun.of({ marks, banner: failed ? `[${name}] ${failed.error}` : null }) });
}

/** Runs the statement at the caret (or the selected ones) of `view`. */
export async function executeInView(view: EditorView, path: string) {
  const sel = view.state.selection.main;
  const outcomes = await executeConsole(path, view.state.doc.toString(), sel.from, sel.to);
  if (outcomes.length) markOutcomes(view, outcomes);
}

/** Explain Plan of the statement at the caret (or the first selected one) of `view`. */
export async function explainInView(view: EditorView, path: string) {
  const sel = view.state.selection.main;
  await explainConsole(path, view.state.doc.toString(), sel.from, sel.to);
}

const consolePath = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });

function ConsoleBar({ path, view }: { path: string; view: EditorView }) {
  const sources = useDatabase((s) => s.sources);
  const loaded = useDatabase((s) => s.loaded);
  const bound = useDatabase(() => consoleSource(path));
  const running = useDatabase((s) => !!s.running[path]);
  const maxRows = useDatabase((s) => s.maxRows);
  const manual = useDatabase((s) => !!bound && s.manualCommit.has(bound));
  const pending = useDatabase((s) => !!bound && s.pendingTx.has(bound));
  const databases = useDatabase((s) => s.databases);
  const boundId = bound ? splitTarget(bound).id : null;
  useEffect(() => {
    if (boundId && listsDatabases(sourceById(boundId)) && !useDatabase.getState().databases[boundId])
      void loadDatabases(boundId);
  }, [boundId]);
  const targets = useMemo(() => {
    const out: Array<{ value: string; label: string; detail?: string; icon: string }> = [];
    for (const s of sources) {
      const id = s.id ?? "";
      const dbs = databases[id];
      const host = sourceLabel(s).slice((s.name ?? "").length + 1);
      if (listsDatabases(s) && dbs?.status === "ok") {
        for (const name of dbs.value.names)
          out.push({
            value: targetOf(id, name, dbs.value.current),
            label: `${s.name ?? ""}: ${name}`,
            detail: host,
            icon: "database",
          });
      } else out.push({ value: id, label: s.name ?? "", detail: host, icon: "db-schema" });
    }
    // A console bound to a database whose list is not loaded yet still shows it.
    if (bound && !out.some((o) => o.value === bound))
      out.push({ value: bound, label: targetLabel(bound), icon: "database" });
    return out;
  }, [sources, databases, bound]);
  useEffect(() => {
    if (!loaded) void loadSources();
  }, [loaded]);
  useEffect(() => {
    if (bound) void loadCompletion(bound);
  }, [bound]);
  return (
    <div className={styles.consoleBar}>
      <IconButton
        icon="run"
        title="Execute"
        shortcut={shortcutLabel("db.execute")}
        disabled={!bound || running}
        onClick={() => void executeInView(view, path)}
      />
      <IconButton
        icon="db-plan"
        title="Explain Plan"
        disabled={!bound || running}
        onClick={() => void explainInView(view, path)}
      />
      <IconButton
        icon="stop"
        title="Cancel Running Statement"
        disabled={!running}
        onClick={() => cancelConsole(path)}
      />
      <span className={styles.toolbarSeparator} />
      <IconButton icon="history" title="Browse Query History" disabled={!bound} onClick={() => openHistory(path)} />
      <span className={styles.toolbarSeparator} />
      <Select
        aria-label="Row limit"
        value={String(maxRows)}
        options={ROW_LIMITS.map((v) => ({ value: v, label: tx`${Number(v).toLocaleString("en")} rows` }))}
        onChange={(v) => useDatabase.setState({ maxRows: Number(v) })}
      />
      <span className={styles.toolbarSeparator} />
      <Select
        aria-label="Transaction mode"
        value={manual ? "manual" : "auto"}
        options={[
          { value: "auto", label: "Tx: Auto" },
          { value: "manual", label: "Tx: Manual" },
        ]}
        onChange={(v) => bound && void setManualCommit(bound, v === "manual")}
        disabled={!bound}
      />
      {manual && (
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
      <span className={styles.spacer} />
      <Select
        aria-label="Data source"
        value={bound ?? null}
        placeholder={sources.length ? "<data source>" : "None configured"}
        options={targets}
        onChange={(id) => bindConsole(path, id)}
        disabled={!sources.length}
      />
    </div>
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

function applyCandidate(c: SqlCandidate, driver: DbDriver) {
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
    const a = analyze(view.state.doc.toString(), to, driver);
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
function completionSource(path: string): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const id = consoleSource(path);
    const source = sourceById(id);
    const driver: DbDriver = source?.driver ?? "sqlite";
    const model = id ? (useDatabase.getState().completion[id] ?? null) : null;
    if (id && !model) void loadCompletion(id);
    // A selected template placeholder (`alias`) is about to be replaced: analyze without it.
    const sel = ctx.state.selection.main;
    const placeholder = !sel.empty && (ctx.pos === sel.from || ctx.pos === sel.to);
    const doc = ctx.state.doc.toString();
    const analysis = placeholder
      ? analyze(doc.slice(0, sel.from) + doc.slice(sel.to), sel.from, driver)
      : analyze(doc, ctx.pos, driver);
    if (!ctx.explicit && !shouldAutoCompleteSql(analysis)) return null;
    const candidates = sqlCandidates({ model, analysis, driver, sourceName: source?.name ?? undefined });
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
        apply: applyCandidate(c, driver),
      })),
      validFor: /^[\p{L}\p{N}_$]*$/u,
    };
  };
}

const noKeywords: CompletionSource = (ctx) => ({ from: ctx.pos, options: [] });

function driverOf(path: string): DbDriver {
  return sourceById(consoleSource(path))?.driver ?? "sqlite";
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
    showPanel.of(consolePanel(ctx.path)),
    EditorState.languageData.of(() => [
      { openideaCompletion: completionSource(ctx.path), [TEMPLATE_CONTEXT_KEY]: templateContextsAt(ctx.path) },
    ]),
    completeAfterTemplate,
    valuesInfo(ctx.path),
    sqlSupport(ctx.path),
    // The grammar's keyword list would duplicate ours (it is the fallback without a language server).
    Prec.highest(EditorState.languageData.of(() => [{ autocomplete: noKeywords }])),
  ];
}
