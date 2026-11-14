/**
 * Pull Members Up / Push Members Down, IDEA's class-hierarchy refactorings. The
 * backend (the app-owned JDT extension for Java, the native engine for PHP) lists the class's members and
 * destinations, checks the chosen move and computes the edit; the dialog
 * (`HierarchyDialog.tsx`) picks the members, problems are confirmed like IDEA's
 * "Problems Detected", and the edit is applied as one change (or previewed first).
 */
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { create } from "zustand";
import type {
  HierarchyChoice,
  HierarchyMemberKind,
  HierarchyMembers,
  HierarchyRefactoring,
  Pos,
  RefactoringProblem,
  WorkspaceEdit,
} from "@/bindings";
import { commands, isCancelled, nextRequestId, unavailableText } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { whenAllSynced, whenSynced } from "@/editor/api";
import { ask } from "@/workbench/messages";
import { docOf, isUnavailable, lspRequest, reportLspError } from "@/editor/lsp/lsp";
import { offsetToPos } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { openPopup } from "@/editor/lsp/popupStore";
import { summarizeWorkspaceEdit } from "@/editor/lsp/workspaceEdit";
import { cannotPerform } from "./catalog";

export interface MemberRow {
  id: string;
  label: string;
  kind: HierarchyMemberKind;
  checked: boolean;
  /** Pull up: declare abstract in the destination. Push down: keep an abstract declaration. */
  makeAbstract: boolean;
  abstractable: boolean;
}

export function initialRows(info: HierarchyMembers): MemberRow[] {
  return info.members.map((m) => ({
    id: m.id,
    label: m.label,
    kind: m.kind,
    checked: m.selected,
    makeAbstract: false,
    abstractable: m.abstractable,
  }));
}

/** A method pulled up to an interface is only declared there (JDT, like IDEA, never moves its body). */
export function abstractForced(row: MemberRow, kind: HierarchyRefactoring, toInterface: boolean): boolean {
  return kind === "pullUp" && toInterface && row.kind === "method";
}

export function choicesOf(
  rows: readonly MemberRow[],
  kind: HierarchyRefactoring,
  toInterface: boolean,
): HierarchyChoice[] {
  return rows
    .filter((r) => r.checked)
    .map((r) => ({
      id: r.id,
      makeAbstract: abstractForced(r, kind, toInterface) || (r.abstractable && r.makeAbstract),
    }));
}

/** The first fatal problem: nothing can be done. */
export function fatalProblem(problems: readonly RefactoringProblem[]): string | null {
  return problems.find((p) => p.severity === "fatal")?.message ?? null;
}

/** Problems the user confirms before the change is made (IDEA lists errors and warnings). */
export function conflicts(problems: readonly RefactoringProblem[]): string[] {
  return problems.filter((p) => p.severity === "error" || p.severity === "warning").map((p) => p.message);
}

export function titleOf(kind: HierarchyRefactoring): string {
  return kind === "pullUp" ? "Pull Members Up" : "Push Members Down";
}

export interface HierarchyRequest {
  seq: number;
  view: EditorView;
  kind: HierarchyRefactoring;
  doc: number;
  pos: Pos;
  /** The document `pos` refers to. */
  text: Text;
  info: HierarchyMembers;
}

export const useHierarchyDialog = create<{ request: HierarchyRequest | null }>(() => ({ request: null }));
let seq = 0;
let running: AbortController | null = null;

function errorText(e: unknown): string {
  if (isUnavailable(e)) return unavailableText(e, "No language server available");
  return e instanceof Error ? e.message : String(e);
}

/** Pull Members Up… / Push Members Down…: asks the server what can move, then opens the dialog. */
export async function startHierarchyRefactoring(view: EditorView, kind: HierarchyRefactoring): Promise<void> {
  const ctx = docOf(view);
  if (!ctx) return;
  if (ctx.readOnly) {
    showHint(view, cannotPerform("The file is read-only"));
    return;
  }
  running?.abort();
  const run = (running = new AbortController());
  await whenSynced(view);
  const state = view.state;
  const pos = offsetToPos(state.doc, state.selection.main.head);
  const request = nextRequestId();
  const abort = () => void commands.cancelRequest(request);
  run.signal.addEventListener("abort", abort);
  try {
    const info = await lspRequest(() => commands.lspHierarchyMembers(request, ctx.doc, pos, kind));
    if (run.signal.aborted || view.state.doc !== state.doc) return;
    useHierarchyDialog.setState({ request: { seq: ++seq, view, kind, doc: ctx.doc, pos, text: state.doc, info } });
  } catch (e) {
    if (isCancelled(e) || run.signal.aborted) return;
    showHint(view, cannotPerform(errorText(e)));
  } finally {
    run.signal.removeEventListener("abort", abort);
    if (running === run) running = null;
  }
}

async function applyEdit(view: EditorView, edit: WorkspaceEdit) {
  try {
    await whenAllSynced();
    await lspRequest(() => commands.applyWorkspaceEdit(edit));
  } catch (e) {
    reportLspError(view, e, true);
  }
}

/** IDEA's "Problems Detected": true to go on anyway. */
async function confirmConflicts(messages: readonly string[]): Promise<boolean> {
  const { button } = await ask({
    title: "Problems Detected",
    icon: "warning",
    body: messages.join("\n"),
    buttons: [
      { id: "continue", label: "Continue", primary: true },
      { id: "cancel", label: "Cancel" },
    ],
  });
  return button === "continue";
}

export type RefactorOutcome =
  /** The edit was applied or handed to the preview: close the dialog. */
  | { status: "done" }
  /** Stay in the dialog (the user cancelled at the problems); `error` says why nothing can be done. */
  | { status: "stay"; error?: string };

/**
 * Checks the chosen move, confirms its problems and applies the edit, or opens the
 * preview with `preview`. The dialog stays open until the change is made.
 */
export async function refactorHierarchy(
  request: HierarchyRequest,
  target: string | null,
  choices: HierarchyChoice[],
  preview: boolean,
): Promise<RefactorOutcome> {
  const { view, kind } = request;
  // The position names the class: after an edit it may name another one.
  if (view.state.doc !== request.text) return { status: "stay", error: "The file changed; open the dialog again" };
  let refactored;
  try {
    await whenSynced(view);
    refactored = await lspRequest(() =>
      commands.lspHierarchyRefactor(nextRequestId(), request.doc, request.pos, kind, target, choices),
    );
  } catch (e) {
    if (isCancelled(e)) return { status: "stay" };
    return { status: "stay", error: errorText(e) };
  }
  const fatal = fatalProblem(refactored.problems);
  if (fatal || !refactored.edit) return { status: "stay", error: fatal ?? "Nothing to change" };
  const found = conflicts(refactored.problems);
  if (found.length && !(await confirmConflicts(found))) return { status: "stay" };
  const edit = refactored.edit;
  const summary = summarizeWorkspaceEdit(edit);
  if (!summary.files) return { status: "stay", error: "Nothing to change" };
  if (preview) {
    openPopup({
      kind: "preview",
      title:
        kind === "pullUp"
          ? tx`Pull Members Up from '${request.info.className}'`
          : tx`Push Members Down from '${request.info.className}'`,
      summary,
      confirmLabel: "Do Refactor",
      onConfirm: () => void applyEdit(view, edit),
    });
  } else {
    await applyEdit(view, edit);
  }
  return { status: "done" };
}
