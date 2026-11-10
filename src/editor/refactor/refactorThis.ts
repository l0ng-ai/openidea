/**
 * Refactor This (⌃T) and the Refactor menu actions. One cancellable
 * `refactor*` code-action query per invocation; server actions are mapped to
 * IDEA's refactorings (`catalog.ts`), client-side ones (Rename, Safe Delete,
 * syntax-based Introduce Variable / Constant) are offered when they apply.
 * Menu items always run, and say why with IDEA's "Cannot perform
 * refactoring. <reason>" when nothing applies.
 */
import type { EditorView } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import type { CodeAction, CodeActionQuery } from "@/bindings";
import { commands, isCancelled } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { whenSynced } from "@/editor/api";
import { structure } from "@/editor/structure";
import { docOf, isUnavailable, lspRequest } from "@/editor/lsp/lsp";
import { offsetToPos, offsetsToRange } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { caretAnchor, openPopup, type ListPopupItem } from "@/editor/lsp/popupStore";
import { applyCodeAction } from "@/editor/lsp/intentions";
import { planLocalRename } from "@/editor/lsp/syntaxFallback";
import {
  HIERARCHY_REFACTORINGS,
  REFACTORINGS,
  cannotPerform,
  classifyAction,
  kindAdvertised,
  refactoring,
  type Refactoring,
  type RefactoringId,
} from "./catalog";
import { introduceFallback, type IntroduceKind } from "./introduce";
import { languageName, queryRefactorActions } from "./query";
import {
  EXPRESSION_REFACTORINGS,
  applyIntroduceAction,
  chooseExpressionFirst,
  chooseOccurrences,
  introducesName,
} from "./serverIntroduce";
import { safeDelete } from "./safeDelete";
import { startHierarchyRefactoring } from "./hierarchy";

/** Languages whose server runs the class-hierarchy refactorings (the app-owned JDT extension). */
const HIERARCHY_LANGUAGES = new Set(["java"]);

/** Outcome of the server query: its answer, or why there is none. */
export type ServerAnswer =
  | { status: "ok"; query: CodeActionQuery }
  | { status: "notReady" }
  | { status: "error"; message: string };

async function askServer(view: EditorView, signal?: AbortSignal, only?: string[]): Promise<ServerAnswer> {
  try {
    return { status: "ok", query: await queryRefactorActions(view, signal, only) };
  } catch (e) {
    if (isCancelled(e)) throw e;
    if (isUnavailable(e)) return { status: "notReady" };
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Server actions per IDEA refactoring, plus the unmapped refactorings (by title). */
export function groupActions(actions: readonly CodeAction[]): {
  mapped: Map<RefactoringId, CodeAction[]>;
  other: CodeAction[];
} {
  const mapped = new Map<RefactoringId, CodeAction[]>();
  const other: CodeAction[] = [];
  for (const a of actions) {
    if (a.disabledReason) continue;
    const id = classifyAction(a);
    if (!id) {
      other.push(a);
      continue;
    }
    let list = mapped.get(id);
    if (!list) mapped.set(id, (list = []));
    list.push(a);
  }
  return { mapped, other };
}

/**
 * Applies the single action, or lets the user pick one. Introduce / Extract
 * actions offer IDEA's occurrences choice and rename the new name in place.
 */
function runActions(view: EditorView, title: string, actions: readonly CodeAction[], id: RefactoringId | null = null) {
  if (id && EXPRESSION_REFACTORINGS.has(id) && chooseOccurrences(view, actions, id)) return;
  const apply = (a: CodeAction) =>
    id && introducesName(id) ? applyIntroduceAction(view, a, id) : applyCodeAction(view, a);
  if (actions.length === 1) return apply(actions[0]!);
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, view.state.selection.main.head),
    title,
    items: actions.map((a, i) => ({
      id: `${i}`,
      label: a.title,
      icon: "bulb",
      emphasis: a.isPreferred,
      run: () => apply(a),
    })),
  });
}

const INTRODUCE: Partial<Record<RefactoringId, IntroduceKind>> = {
  extractVariable: "variable",
  extractConstant: "constant",
};

/** First error diagnostic on the selected lines (servers offer nothing over broken code). */
function errorAround(view: EditorView): string | null {
  const sel = view.state.selection.main;
  const from = view.state.doc.lineAt(sel.from).from;
  const to = view.state.doc.lineAt(sel.to).to;
  let error: string | null = null;
  forEachDiagnostic(view.state, (d, a, b) => {
    if (!error && d.severity === "error" && a <= to && b >= from) error = d.message;
  });
  return error;
}

/** IDEA's reason for `r` being unavailable, given the server's answer. */
export async function unavailableReason(
  view: EditorView,
  r: Refactoring,
  answer: ServerAnswer,
  actions: readonly CodeAction[],
): Promise<string> {
  const ctx = docOf(view);
  const lang = await languageName(ctx?.language ?? "");
  if (answer.status === "notReady") return `No language server for ${lang} is running`;
  if (answer.status === "error") return answer.message;
  const disabled = actions.find((a) => a.disabledReason && classifyAction(a) === r.id)?.disabledReason;
  if (disabled) return disabled;
  if (r.kind && !kindAdvertised(answer.query.advertisedKinds, r.kind)) {
    return `The language server for ${lang} doesn't support ${r.label.replace(/…$/, "")}`;
  }
  const error = errorAround(view);
  const reason = r.reason(!view.state.selection.main.empty);
  return error ? `${reason} (fix the error first: ${error})` : reason;
}

let menuRun: AbortController | null = null;

/** A Refactor menu action (Move…, Inline…, Extract Method…): runs it or says why it can't. */
export async function runRefactoring(view: EditorView, id: RefactoringId): Promise<void> {
  const r = refactoring(id);
  const ctx = docOf(view);
  if (!ctx) return;
  if (ctx.readOnly) {
    showHint(view, cannotPerform("The file is read-only"));
    return;
  }
  // IDEA picks the expression first (and the server then extracts exactly that one).
  if (EXPRESSION_REFACTORINGS.has(id) && view.state.selection.main.empty) {
    if (await chooseExpressionFirst(view, () => runRefactoring(view, id))) return;
  }
  menuRun?.abort();
  const run = (menuRun = new AbortController());
  const state = view.state;
  let answer: ServerAnswer;
  try {
    answer = await askServer(view, run.signal, r.kind ? [r.kind] : undefined);
  } catch (e) {
    if (isCancelled(e)) return;
    throw e;
  } finally {
    if (menuRun === run) menuRun = null;
  }
  if (run.signal.aborted || view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) return;
  const all = answer.status === "ok" ? answer.query.actions : [];
  const actions = groupActions(all).mapped.get(id) ?? [];
  if (actions.length) {
    await runActions(view, r.label.replace(/…$/, ""), actions, id);
    return;
  }
  const introduce = INTRODUCE[id];
  if (introduce) {
    const reason = answer.status === "ok" ? "empty" : answer.status === "notReady" ? "notReady" : "error";
    if (await introduceFallback(view, introduce, reason)) return;
  }
  showHint(view, cannotPerform(await unavailableReason(view, r, answer, all)));
}

/** Whether Rename (and so Safe Delete) has a symbol to act on at the caret. */
async function symbolAtCaret(view: EditorView, serverUp: boolean): Promise<boolean> {
  const ctx = docOf(view)!;
  const pos = offsetToPos(view.state.doc, view.state.selection.main.head);
  if (serverUp) {
    try {
      if (await lspRequest(() => commands.lspPrepareRename(ctx.doc, pos))) return true;
    } catch (e) {
      if (isCancelled(e)) throw e;
    }
  }
  try {
    return (await planLocalRename(ctx, pos)).kind === "plan";
  } catch (e) {
    if (isCancelled(e)) throw e;
    return false;
  }
}

async function expressionAtCaret(view: EditorView, signal: AbortSignal): Promise<boolean> {
  const ctx = docOf(view)!;
  const sel = view.state.selection.main;
  try {
    const at = await structure.expressionAt(ctx.doc, offsetsToRange(view.state.doc, sel.from, sel.to), { signal });
    return !!at.expression;
  } catch (e) {
    if (isCancelled(e)) throw e;
    return false;
  }
}

/** Items of the Refactor This popup, IDEA order: applicable IDEA refactorings, then the server's others. */
export function refactorThisItems(
  view: EditorView,
  answer: ServerAnswer,
  facts: { symbol: boolean; expression: boolean; hierarchy?: boolean },
  run: {
    rename: (view: EditorView) => unknown;
    safeDelete: (view: EditorView) => unknown;
    hierarchy?: (view: EditorView, kind: "pullUp" | "pushDown") => unknown;
  },
): ListPopupItem[] {
  const { mapped, other } = groupActions(answer.status === "ok" ? answer.query.actions : []);
  const serverUsable = answer.status === "ok";
  const items: ListPopupItem[] = [];
  const caretOnly = view.state.selection.main.empty;
  for (const r of REFACTORINGS) {
    const actions = mapped.get(r.id) ?? [];
    const expression = EXPRESSION_REFACTORINGS.has(r.id);
    let go: (() => unknown) | null = null;
    // With only a caret the expression is chosen first, then the server asked for it.
    if (expression && caretOnly && serverUsable && (actions.length || facts.expression))
      go = () => runRefactoring(view, r.id);
    else if (actions.length) go = () => runActions(view, r.label.replace(/…$/, ""), actions, r.id);
    else if (r.id === "rename" && facts.symbol) go = () => run.rename(view);
    else if (r.id === "safeDelete" && facts.symbol && !docOf(view)?.readOnly) go = () => run.safeDelete(view);
    else if (HIERARCHY_REFACTORINGS.has(r.id) && facts.hierarchy && serverUsable && run.hierarchy)
      go = () => run.hierarchy!(view, r.id === "pullMembersUp" ? "pullUp" : "pushDown");
    else if (INTRODUCE[r.id] && facts.expression && !serverUsable)
      go = () => introduceFallback(view, INTRODUCE[r.id]!, answer.status === "notReady" ? "notReady" : "error");
    if (!go) continue;
    const exec = go;
    items.push({ id: r.id, label: r.label, shortcut: shortcutLabel(r.action), run: () => void exec() });
  }
  other.forEach((a, i) =>
    items.push({
      id: `server${i}`,
      label: a.title,
      icon: "bulb",
      emphasis: a.isPreferred,
      run: () => applyCodeAction(view, a),
    }),
  );
  return items;
}

let thisRun: AbortController | null = null;

/** ⌃T: only the refactorings applicable at the caret. */
export async function refactorThis(view: EditorView, rename: (view: EditorView) => unknown): Promise<void> {
  const ctx = docOf(view);
  if (!ctx) return;
  thisRun?.abort();
  const run = (thisRun = new AbortController());
  await whenSynced(view);
  const state = view.state;
  let items: ListPopupItem[];
  try {
    const answer = await askServer(view, run.signal);
    const [symbol, expression] = await Promise.all([
      symbolAtCaret(view, answer.status !== "notReady"),
      expressionAtCaret(view, run.signal),
    ]);
    const hierarchy = HIERARCHY_LANGUAGES.has(ctx.language) && !ctx.readOnly;
    items = refactorThisItems(
      view,
      answer,
      { symbol, expression, hierarchy },
      { rename, safeDelete, hierarchy: startHierarchyRefactoring },
    );
  } catch (e) {
    if (isCancelled(e)) return;
    throw e;
  } finally {
    if (thisRun === run) thisRun = null;
  }
  // Superseded, or the caret moved / the text changed meanwhile: the answer is stale.
  if (run.signal.aborted || view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) return;
  if (!items.length) {
    showNothingHere(caretAnchor(view, state.selection.main.head));
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, state.selection.main.head),
    title: "Refactor This",
    items,
    numbered: true,
  });
}

/** IDEA's "Nothing here" popup: Refactor This where no refactoring applies (or outside an editor). */
export function showNothingHere(
  anchor: { x: number; y: number } = { x: window.innerWidth / 2, y: window.innerHeight / 3 },
) {
  openPopup({
    kind: "list",
    anchor,
    title: "Refactor This",
    items: [{ id: "nothing", label: "Nothing here", disabled: "No refactoring applies here", run: () => {} }],
  });
}
