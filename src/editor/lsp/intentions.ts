/**
 * Code actions: the lightbulb on the caret line (debounced lookup), the ⌥↵
 * intentions popup (quick fixes first, preferred in bold), Optimize Imports and
 * Generate. Refactor This and the Refactor menu live in `@/editor/refactor`.
 */
import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import { indentUnit } from "@codemirror/language";
import { diff } from "@codemirror/merge";
import { commands, isCancelled, type CodeAction } from "@/platform/ipc";
import { contributedIntentions, intentionProviders, whenSynced } from "@/editor/api";
import { shortcutLabel } from "@/platform/keymap";
import { debounce, docOf, isUnavailable, lspRequest, reportLspError } from "./lsp";
import { offsetsToRange } from "./positions";
import { showHint } from "./hint";
import { formatLines } from "./format";
import { pythonMemberIntentions } from "./pythonMembers";
import { caretAnchor, openPopup, type ListPopupItem, type ListPreview } from "./popupStore";
import { editPreviewLines } from "./workspaceEdit";
import { featureBackoff } from "./availability";
import { iconNode } from "./iconMarkup";
import { editorPrefs } from "@/platform/editorSettings";
import { spellingIntentions } from "./spelling";
import { inspectionsAt } from "./diagnostics";
import { SPELLING_INSPECTION } from "@/platform/inspections";
import { editInspectionSettings, intentionControls } from "@/platform/inspectionControls";
import { tx } from "@/platform/i18n";

const codeActionBackoff = featureBackoff();

const isQuickFix = (a: CodeAction) => !!a.kind && (a.kind === "quickfix" || a.kind.startsWith("quickfix."));

/** IDEA ordering: quick fixes first, preferred before others, disabled last; stable otherwise. */
export function sortCodeActions(actions: readonly CodeAction[]): CodeAction[] {
  const rank = (a: CodeAction) => (a.disabledReason ? 4 : 0) + (isQuickFix(a) ? 0 : 2) + (a.isPreferred ? 0 : 1);
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a);
}

async function fetchActions(view: EditorView, only: string[], whole = false): Promise<CodeAction[]> {
  const doc = docOf(view);
  if (!doc) return [];
  await whenSynced(view);
  const sel = view.state.selection.main;
  const range = whole
    ? offsetsToRange(view.state.doc, 0, view.state.doc.length)
    : offsetsToRange(view.state.doc, sel.from, sel.to);
  return lspRequest(() => commands.lspCodeActions(doc.doc, range, only));
}

interface PlacedProblem {
  from: number;
  to: number;
  severity: string;
}

/**
 * As in IDEA, when no error touches the caret, the fixes of an
 * error elsewhere on the caret line are offered too. The errors to ask about,
 * in line order; none when an error is at the caret.
 */
export function lineErrorsAwayFromCaret(
  problems: readonly PlacedProblem[],
  lineFrom: number,
  lineTo: number,
  caret: number,
): PlacedProblem[] {
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.some((p) => p.from <= caret && caret <= p.to)) return [];
  return errors.filter((p) => p.from >= lineFrom && p.from <= lineTo).sort((a, b) => a.from - b.from);
}

/** ⌥↵ / lightbulb actions: those at the caret plus, as in IDEA, quick fixes of another error on the line. */
async function fetchIntentions(view: EditorView): Promise<CodeAction[]> {
  const actions = (await fetchActions(view, [])).filter((a) => !a.disabledReason);
  const doc = docOf(view);
  const state = view.state;
  const sel = state.selection.main;
  if (!doc || !sel.empty) return actions;
  const line = state.doc.lineAt(sel.head);
  const problems: PlacedProblem[] = [];
  forEachDiagnostic(state, (d, from, to) => problems.push({ from, to, severity: d.severity }));
  const titles = new Set(actions.map((a) => a.title));
  for (const p of lineErrorsAwayFromCaret(problems, line.from, line.to, sel.head)) {
    let more: CodeAction[];
    try {
      more = await lspRequest(() =>
        commands.lspCodeActions(doc.doc, offsetsToRange(state.doc, p.from, p.to), ["quickfix"]),
      );
    } catch {
      break;
    }
    if (view.state.doc !== state.doc) break;
    const fixes = more.filter((a) => isQuickFix(a) && !a.disabledReason && !titles.has(a.title));
    if (fixes.length) {
      actions.push(...fixes);
      break;
    }
  }
  return actions;
}

/** Enabled quick fixes of the problem at `from..to`, preferred first. */
export async function quickFixesAt(view: EditorView, from: number, to: number): Promise<CodeAction[]> {
  const doc = docOf(view);
  if (!doc) return [];
  await whenSynced(view);
  const actions = await lspRequest(() =>
    commands.lspCodeActions(doc.doc, offsetsToRange(view.state.doc, from, to), ["quickfix"]),
  );
  return sortCodeActions(actions.filter((a) => isQuickFix(a) && !a.disabledReason));
}

/**
 * ⌥⇧↵: applies the preferred (else first) quick fix of the most severe problem
 * at the caret, or of one elsewhere on the caret line.
 */
export async function applyQuickFix(view: EditorView) {
  const state = view.state;
  const caret = state.selection.main.head;
  const line = state.doc.lineAt(caret);
  const problems: Array<PlacedProblem & { rank: number }> = [];
  forEachDiagnostic(state, (d, from, to) => {
    if (d.severity === "hint" || to < line.from || from > line.to) return;
    const rank =
      (d.severity === "error" ? 0 : d.severity === "warning" ? 1 : 2) + (from <= caret && caret <= to ? 0 : 3);
    problems.push({ from, to, severity: d.severity, rank });
  });
  problems.sort((a, b) => a.rank - b.rank);
  try {
    for (const p of problems) {
      const fix = (await quickFixesAt(view, p.from, p.to))[0];
      if (view.state.doc !== state.doc) return;
      if (fix) return applyCodeAction(view, fix);
    }
  } catch (e) {
    reportLspError(view, e, true);
    return;
  }
  showHint(view, "No quick fixes available");
}

export async function applyCodeAction(view: EditorView, action: CodeAction) {
  const doc = docOf(view);
  if (!doc) return;
  if (action.disabledReason) {
    showHint(view, action.disabledReason);
    return;
  }
  const before = view.state.doc;
  try {
    await lspRequest(() => commands.lspApplyCodeAction(doc.doc, action));
  } catch (e) {
    reportLspError(view, e, true);
    return;
  }
  if (!action.kind?.startsWith("source.organizeImports") && !action.kind?.startsWith("source.fixAll"))
    await reformatGenerated(view, before);
}

/**
 * Code the server generated follows its own indentation (jdtls tabs,
 * tsserver 4 spaces); like IDEA, the lines an action inserted are reformatted
 * to the file's style.
 */
async function reformatGenerated(view: EditorView, before: Text) {
  for (let i = 0; i < 100 && view.state.doc === before; i++) await new Promise((r) => setTimeout(r, 20));
  // Bottom up, so the line numbers of the hunks above stay valid.
  for (const lines of changedLines(before, view.state.doc).reverse()) {
    if (lines.to - lines.from < 1) continue;
    const doc = view.state.doc;
    const shift = indentUnderBrace(doc, lines.from, lines.to, view.state.facet(indentUnit));
    // A server that generated code without its context formats ranges the same
    // way (back to column 0): its range formatting is skipped then.
    if (shift.length) view.dispatch({ changes: shift, userEvent: "format", scrollIntoView: false });
    else if (!(await formatLines(view, doc.line(lines.from).from, doc.line(lines.to).to)) && view.state.doc !== doc)
      return;
  }
}

/**
 * Generated lines right under a `{` line but not indented past it (servers
 * that format the snippet on its own, kotlin-language-server): the block moves
 * one level in, keeping its own nesting. Never applies to indentation-based
 * languages, whose blocks don't open with `{`.
 */
export function indentUnderBrace(
  doc: Text,
  fromLine: number,
  toLine: number,
  unit: string,
): Array<{ from: number; insert: string }> {
  if (fromLine < 2) return [];
  const prev = doc.line(fromLine - 1).text;
  if (!prev.trimEnd().endsWith("{")) return [];
  const lead = (t: string) => t.slice(0, t.length - t.trimStart().length);
  const target = lead(prev) + unit;
  let first: string | null = null;
  for (let n = fromLine; n <= toLine && first === null; n++)
    if (doc.line(n).text.trim()) first = lead(doc.line(n).text);
  if (first === null || first.length > lead(prev).length || !target.startsWith(first)) return [];
  const extra = target.slice(first.length);
  const out: Array<{ from: number; insert: string }> = [];
  for (let n = fromLine; n <= toLine; n++) {
    const line = doc.line(n);
    if (line.text.trim()) out.push({ from: line.from, insert: extra });
  }
  return out;
}

/**
 * 1-based line spans of `after` that an edit changed, top to bottom: an added
 * import and the code using it are separate spans, so the user's code between
 * them is left alone.
 */
export function changedLines(before: Text, after: Text): Array<{ from: number; to: number }> {
  if (before.eq(after)) return [];
  const spans: Array<{ from: number; to: number }> = [];
  const a = before.toString();
  const b = after.toString();
  for (const c of diff(a, b)) {
    // Text inserted at a line's end or start (`{⏎ added`, `added⏎`) leaves that line as it was.
    const lead = b[c.fromB] === "\n" && (c.toA === c.fromA || a[c.fromA] === "\n");
    const trail = c.toB > c.fromB && b[c.toB - 1] === "\n" && (c.toA === c.fromA || a[c.toA - 1] === "\n");
    const from = after.lineAt(lead ? c.fromB + 1 : c.fromB).number;
    const end = trail ? c.toB - 1 : c.toB;
    const to = Math.max(from, after.lineAt(end).number);
    const last = spans[spans.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else spans.push({ from, to });
  }
  return spans;
}

/**
 * Applies the first enabled whole-file action of `kind` without UI (Actions on
 * Save). Waits until the backend edit reached this editor; false when none.
 */
export async function applyKindSilently(view: EditorView, kind: string): Promise<boolean> {
  const doc = docOf(view);
  if (!doc || doc.readOnly) return false;
  let actions: CodeAction[];
  try {
    actions = (await fetchActions(view, [kind], true)).filter((a) => a.kind?.startsWith(kind) && !a.disabledReason);
  } catch {
    return false;
  }
  const action = actions.find((a) => a.isPreferred) ?? actions[0];
  if (!action) return false;
  const before = view.state.doc;
  try {
    await lspRequest(() => commands.lspApplyCodeAction(doc.doc, action));
  } catch {
    return false;
  }
  for (let i = 0; i < 25 && view.state.doc === before; i++) await new Promise((r) => setTimeout(r, 20));
  return true;
}

/**
 * Sorted, one action per title: servers can report the same action under two
 * kinds (jdtls: "Generate toString()" as quickassist and source.generate).
 */
export function listedCodeActions(actions: readonly CodeAction[]): CodeAction[] {
  const seen = new Set<string>();
  return sortCodeActions(actions).filter((a) => !seen.has(a.title) && !!seen.add(a.title));
}

function actionItems(
  view: EditorView,
  actions: CodeAction[],
  resolved?: Map<CodeAction, Promise<CodeAction>>,
): ListPopupItem[] {
  return listedCodeActions(actions).map((a, i) => ({
    id: `${i}`,
    label: a.title,
    icon: isQuickFix(a) ? "bulb-fix" : "bulb",
    emphasis: a.isPreferred,
    disabled: a.disabledReason,
    // The edit the preview already resolved is applied as is.
    run: async () => applyCodeAction(view, (await resolved?.get(a)?.catch(() => a)) ?? a),
  }));
}

/** The action with its edit (resolved once per popup; servers may compute edits lazily). */
function resolveOnce(
  doc: number,
  action: CodeAction,
  cache: Map<CodeAction, Promise<CodeAction>>,
): Promise<CodeAction> {
  let p = cache.get(action);
  if (!p) {
    p =
      action.edit || action.command
        ? Promise.resolve(action)
        : lspRequest(() => commands.lspResolveCodeAction(doc, action));
    cache.set(action, p);
    p.catch(() => cache.delete(action));
  }
  return p;
}

/** Intention preview (IDEA's side panel): the diff the action would make to this file. */
export async function intentionPreview(
  view: EditorView,
  action: CodeAction,
  cache: Map<CodeAction, Promise<CodeAction>>,
  signal: AbortSignal,
): Promise<ListPreview | null> {
  const ctx = docOf(view);
  if (!ctx) return null;
  const doc = view.state.doc;
  const full = await resolveOnce(ctx.doc, action, cache);
  if (signal.aborted || view.state.doc !== doc) return null;
  const files = full.edit?.files ?? [];
  const here = files.find((f) => f.kind === "edit" && f.path === ctx.path);
  const others = new Set(files.map((f) => (f.kind === "rename" ? f.from : f.path)).filter((p) => p !== ctx.path)).size;
  const note = others ? `Also changes ${others} other ${others === 1 ? "file" : "files"}` : undefined;
  if (here?.kind === "edit") {
    const lines = editPreviewLines(doc, here.edits);
    if (lines.length) return { kind: "diff", lines, note };
  }
  if (note) return { kind: "text", text: note };
  return {
    kind: "text",
    text: full.command && !full.edit ? "Preview isn't available for this action" : "No changes in this file",
  };
}

/**
 * IDEA's → menu on inspection-derived intentions: with one inspection reporting
 * at the caret its quick fixes get its controls (Edit inspection profile
 * setting, Disable inspection); otherwise each inspection there gets a row of
 * its own. Typo fixes carry theirs already.
 */
export function withInspectionControls(view: EditorView, items: ListPopupItem[]): ListPopupItem[] {
  const doc = docOf(view);
  if (!doc) return items;
  const inspections = inspectionsAt(doc.path, view.state.doc, view.state.selection.main.head).filter(
    (i) => i.id !== SPELLING_INSPECTION,
  );
  if (!inspections.length) return items;
  const fixes = items.filter((i) => i.icon === "bulb-fix" && !i.submenu);
  if (inspections.length === 1 && fixes.length) {
    const submenu = intentionControls(inspections[0]!);
    return items.map((i) => (fixes.includes(i) ? { ...i, submenu } : i));
  }
  return [
    ...items,
    ...inspections.map((inspection) => ({
      id: `inspection:${inspection.id}`,
      label: tx`Inspection '${inspection.name}' options`,
      icon: "settings",
      run: () => editInspectionSettings(inspection.id),
      submenu: intentionControls(inspection),
    })),
  ];
}

/** ⌥↵ */
export async function showIntentions(view: EditorView) {
  try {
    // Typo fixes and feature-contributed actions come first and need no language server.
    const local: ListPopupItem[] = [...spellingIntentions(view), ...contributedIntentions(view)];
    let actions: CodeAction[] = [];
    let failure: { error: unknown } | null = null;
    try {
      // Like IDEA, only applicable intentions are listed (servers also report disabled refactorings).
      actions = await fetchIntentions(view);
    } catch (e) {
      failure = { error: e };
    }
    const sorted = listedCodeActions(actions);
    const resolved = new Map<CodeAction, Promise<CodeAction>>();
    const items = withInspectionControls(view, [...local, ...actionItems(view, sorted, resolved)]);
    if (!items.length) {
      if (failure) throw failure.error;
      showHint(view, "No intentions available");
      return;
    }
    openPopup({
      kind: "list",
      anchor: caretAnchor(view, view.state.selection.main.head),
      title: "Intentions",
      items,
      preview: (item, signal) => {
        const action = sorted[items.indexOf(item) - local.length];
        return action ? intentionPreview(view, action, resolved, signal) : Promise.resolve(null);
      },
    });
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/** Runs the single matching action of `kind` (optionally filtered by title), or offers a choice. */
export async function runKindAction(
  view: EditorView,
  /** LSP `CodeActionKind` prefix; `""` for any kind. */
  kind: string,
  opts: {
    title?: RegExp;
    whole?: boolean;
    none: string;
    label: string;
    /**
     * Syntax-based fallback when the server offers no enabled action
     * (`empty`) or cannot answer; true when it handled the request.
     */
    fallback?: (reason: "notReady" | "error" | "empty") => Promise<boolean>;
  },
) {
  let actions: CodeAction[];
  try {
    // An empty kind asks for every action (filtered by title only).
    actions = await fetchActions(view, kind ? [kind] : [], opts.whole);
  } catch (e) {
    if (!isCancelled(e) && opts.fallback && (await opts.fallback(isUnavailable(e) ? "notReady" : "error"))) return;
    reportLspError(view, e, true);
    return;
  }
  try {
    if (kind) actions = actions.filter((a) => a.kind?.startsWith(kind) ?? false);
    if (opts.title) actions = actions.filter((a) => opts.title!.test(a.title));
    const enabled = actions.filter((a) => !a.disabledReason);
    if (!enabled.length) {
      if (opts.fallback && (await opts.fallback("empty"))) return;
      showHint(view, actions[0]?.disabledReason ?? noActionReason(view, opts.none));
      return;
    }
    if (enabled.length === 1) {
      await applyCodeAction(view, enabled[0]!);
      return;
    }
    openPopup({
      kind: "list",
      anchor: caretAnchor(view, view.state.selection.main.head),
      title: opts.label,
      items: actionItems(view, enabled),
    });
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/** Servers offer no refactorings over broken code; say so instead of a bare "cannot". */
function noActionReason(view: EditorView, none: string): string {
  const sel = view.state.selection.main;
  const from = view.state.doc.lineAt(sel.from).from;
  const to = view.state.doc.lineAt(sel.to).to;
  let error: string | null = null;
  forEachDiagnostic(view.state, (d, a, b) => {
    if (!error && d.severity === "error" && a <= to && b >= from) error = d.message;
  });
  return error ? `${none}: fix the error first (${error})` : none;
}

// ---------------------------------------------------------------------------
// Lightbulb

/**
 * Fixes and refactorings light the bulb; source actions (organize imports,
 * generate…) and server extras (gopls "Browse documentation") are offered on
 * almost every line and only appear in the ⌥↵ list.
 */
export function lightsBulb(a: CodeAction): boolean {
  const kind = a.kind ?? "";
  return !kind || kind === "quickassist" || /^(quickfix|refactor)(\.|$)/.test(kind);
}

interface Bulb {
  line: number;
  quickFix: boolean;
}

const setBulb = StateEffect.define<Bulb | null>();

const bulbField = StateField.define<Bulb | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBulb)) return e.value;
    if (value && (tr.docChanged || tr.selection)) {
      const line = tr.state.doc.lineAt(tr.state.selection.main.head).number;
      return line === value.line && !tr.docChanged ? value : null;
    }
    return value;
  },
});

const bulbPlugin = ViewPlugin.fromClass(
  class {
    private lookup = debounce(() => void this.run(), 500);
    constructor(private view: EditorView) {
      this.lookup();
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || (u.focusChanged && u.view.hasFocus)) this.lookup();
      else if (u.focusChanged) {
        this.lookup.cancel();
        // A blur dispatched from inside the update is not allowed.
        queueMicrotask(() => {
          if (!this.view.hasFocus && this.view.state.field(bulbField, false))
            this.view.dispatch({ effects: setBulb.of(null) });
        });
      }
    }
    async run() {
      const doc = docOf(this.view);
      // As in IDEA, only the focused editor shows the bulb.
      if (!doc || doc.readOnly || !this.view.dom.isConnected || !this.view.hasFocus) return;
      const state = this.view.state;
      const typoFix = spellingIntentions(this.view).length > 0;
      const local = typoFix || contributedIntentions(this.view).length > 0;
      const backoff = codeActionBackoff.active(doc.doc);
      if (backoff && !local) return;
      let actions: CodeAction[] = [];
      if (!backoff) {
        try {
          actions = await fetchIntentions(this.view);
        } catch (e) {
          if (isUnavailable(e)) codeActionBackoff.mark(doc.doc);
          if (!local) return;
        }
      }
      if (this.view.state.doc !== state.doc || !this.view.state.selection.eq(state.selection) || !this.view.hasFocus)
        return;
      const line = state.doc.lineAt(state.selection.main.head).number;
      const any = actions.some(lightsBulb) || local;
      this.view.dispatch({
        effects: setBulb.of(any ? { line, quickFix: typoFix || actions.some(isQuickFix) } : null),
      });
    }
    destroy() {
      this.lookup.cancel();
    }
  },
);

/**
 * New-UI bulb: floats at the start of the text on the caret line, or on the
 * line below / above when the caret line's text starts at the left edge; in
 * the gutter when none of them has room.
 */
const BULB_COLUMNS = 3;

export function bulbLine(state: EditorView["state"], line: number): { line: number; gutter: boolean } {
  const doc = state.doc;
  const free = (n: number) => {
    if (n < 1 || n > doc.lines) return false;
    const text = doc.line(n).text;
    return text.length - text.trimStart().length >= BULB_COLUMNS || !text.trim();
  };
  for (const n of [line, line + 1, line - 1]) if (free(n)) return { line: n, gutter: false };
  return { line, gutter: true };
}

class FloatingBulb {
  dom: HTMLElement;
  private shown: Bulb | null = null;

  constructor(private view: EditorView) {
    this.dom = document.createElement("span");
    this.dom.className = "cm-lsp-bulb";
    this.dom.setAttribute("role", "button");
    this.dom.setAttribute("aria-label", "Show intentions");
    this.dom.style.display = "none";
    this.dom.appendChild(iconNode("bulb", 16));
    this.dom.appendChild(iconNode("bulb-fix", 16, "cm-lsp-bulb-fix-icon"));
    this.dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void showIntentions(this.view);
    });
    view.scrollDOM.appendChild(this.dom);
    this.place();
  }

  update(u: ViewUpdate) {
    const bulb = u.state.field(bulbField, false) ?? null;
    if (bulb !== this.shown || u.geometryChanged || u.viewportChanged) this.place();
  }

  private place() {
    const bulb = this.view.state.field(bulbField, false) ?? null;
    this.shown = bulb;
    if (!bulb || bulb.line > this.view.state.doc.lines || !editorPrefs().appearance.intentionBulb) {
      this.dom.style.display = "none";
      return;
    }
    const keys = shortcutLabel("code.showIntentions");
    this.dom.title = `Show intentions${keys ? ` (${keys})` : ""}`;
    this.dom.classList.toggle("cm-lsp-bulb-fix", bulb.quickFix);
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const at = bulbLine(view.state, bulb.line);
        const line = view.state.doc.line(at.line);
        const content = view.contentDOM.getBoundingClientRect();
        const scroller = view.scrollDOM.getBoundingClientRect();
        // The text row: the line's block also holds inline widgets above it (code vision).
        const coords = view.coordsAtPos(line.from, 1);
        const block = view.lineBlockAt(line.from);
        const textTop = coords ? coords.top - scroller.top : block.top + view.documentTop - scroller.top;
        return {
          top: textTop + view.scrollDOM.scrollTop,
          left: content.left - scroller.left + view.scrollDOM.scrollLeft + (at.gutter ? -20 : 4),
          height: coords ? coords.bottom - coords.top : block.height,
          gutter: at.gutter,
        };
      },
      write: ({ top, left, height, gutter }) => {
        this.dom.style.display = "";
        this.dom.classList.toggle("cm-lsp-bulb-gutter", gutter);
        this.dom.style.top = `${top}px`;
        this.dom.style.left = `${left}px`;
        this.dom.style.height = `${Math.min(height, this.view.defaultLineHeight)}px`;
      },
    });
  }

  destroy() {
    this.dom.remove();
  }
}

const floatingBulb = ViewPlugin.fromClass(FloatingBulb);

export function intentionsExtension(): Extension {
  return [bulbField, bulbPlugin, floatingBulb, intentionProviders.of(pythonMemberIntentions)];
}
