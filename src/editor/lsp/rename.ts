/**
 * Rename (⇧F6): `lsp_prepare_rename` → the name is edited in place with this
 * file's occurrences linked (`inplaceRename.ts`; ⇧F6 again opens the name
 * dialog) → `lsp_rename` → preview dialog when the edit spans several files
 * (or moves files), otherwise applied directly via `apply_workspace_edit`.
 *
 * Dumb mode: when the server is not ready / failing, or answers nothing over
 * code with syntax errors, a *local* variable is renamed in place from the
 * syntax tree (definition + same-scope references, `{ x }` shorthands keep
 * their key). Anything else — members, types, top-level or cross-file
 * symbols — is left to the server. Ambiguous cases ask first.
 */
import type { EditorView } from "@codemirror/view";
import { commands, isCancelled, unavailableText, type Pos, type WorkspaceEdit } from "@/platform/ipc";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { structure } from "@/editor/structure";
import { docOf, isUnavailable, lspRequest, reportLspError } from "./lsp";
import { comparePos, offsetToPos, rangeToOffsets } from "./positions";
import { showHint } from "./hint";
import { caretAnchor, openPopup, type PreviewOccurrence } from "./popupStore";
import { needsPreview, summarizeWorkspaceEdit } from "./workspaceEdit";
import { endInplaceRename, inplaceSession, startInplaceRename, type Span } from "./inplaceRename";
import { shortcutLabel } from "@/platform/keymap";
import {
  SYNTAX_NOTE,
  VALID_NAME,
  planLocalRename,
  renameChanges,
  renameRisks,
  type LocalRenamePlan,
} from "./syntaxFallback";
import { tx } from "@/platform/i18n";

async function applyEdit(view: EditorView, edit: WorkspaceEdit) {
  try {
    await lspRequest(() => commands.applyWorkspaceEdit(edit));
  } catch (e) {
    reportLspError(view, e, true);
  }
}

async function hasSyntaxErrors(doc: number): Promise<boolean> {
  try {
    return (await structure.syntaxErrors(doc)).errors.length > 0;
  } catch {
    return false;
  }
}

export async function startRename(view: EditorView) {
  const doc = docOf(view);
  if (!doc) return;
  // ⇧F6 while renaming in place: the dialog with more options, keeping what was typed.
  const session = inplaceSession(view.state);
  if (session) {
    const typed = endInplaceRename(view, "restore");
    if (typed !== null) session.dialog(typed);
    return;
  }
  if (doc.readOnly) {
    showHint(view, "The file is read-only");
    return;
  }
  await whenSynced(view);
  const head = view.state.selection.main.head;
  const pos = offsetToPos(view.state.doc, head);
  let range;
  try {
    range = await lspRequest(() => commands.lspPrepareRename(doc.doc, pos));
  } catch (e) {
    if (isCancelled(e)) return;
    if (!(await startSyntaxRename(view, doc, pos, e))) reportLspError(view, e, true);
    return;
  }
  if (!range) {
    // A normal "can't rename" is respected; over broken code the server may just have given up.
    if ((await hasSyntaxErrors(doc.doc)) && (await startSyntaxRename(view, doc, pos))) return;
    showHint(view, "This element can't be renamed");
    return;
  }
  const { from, to } = rangeToOffsets(view.state.doc, range);
  const oldName = view.state.sliceDoc(from, to);
  const dialog = (initial: string) =>
    openPopup({
      kind: "rename",
      anchor: caretAnchor(view, from),
      title: tx`Rename '${oldName}'`,
      initial,
      onSubmit: (newName) => void finishRename(view, doc, pos, oldName, newName),
    });
  if (from === to) {
    dialog(oldName);
    return;
  }
  // IDEA renames in place by default: occurrences in this file follow live.
  const state = view.state;
  const others = await linkedOccurrences(view, doc.doc, pos, { from, to }, oldName);
  if (view.state.doc !== state.doc) return;
  const keys = shortcutLabel("refactor.rename");
  startInplaceRename(view, {
    primary: { from, to },
    others,
    hint: keys ? tx`Press ${keys} to show dialog with more options` : "Rename in place: ↵ to finish, Esc to cancel",
    commit: (newName) => void commitInplace(view, doc, pos, oldName, newName),
    dialog,
  });
}

/** `name` with `[at, at + length)` replaced. */
export function spliceName(name: string, at: number, length: number, replacement: string): string {
  return name.slice(0, at) + replacement + name.slice(at + length);
}

/**
 * Replaces `part` of a declared name (a misspelt word of `checkpointer_pol`)
 * through Rename, so every reference follows. Falls back to the syntax-based
 * local rename; when neither can rename the symbol, says so and changes nothing
 * (a lone text replacement would break the references).
 */
export async function renameNamePart(view: EditorView, part: Span, replacement: string) {
  const doc = docOf(view);
  if (!doc) return;
  if (doc.readOnly) {
    showHint(view, "The file is read-only");
    return;
  }
  const word = view.state.sliceDoc(part.from, part.to);
  await whenSynced(view);
  if (view.state.sliceDoc(part.from, part.to) !== word) return;
  const pos = offsetToPos(view.state.doc, part.from);
  const refuse = (why: string) =>
    showHint(view, `Cannot rename safely: ${why}. '${word}' was left unchanged`, { tone: "warning" });
  const viaSyntax = async (): Promise<boolean> => {
    const plan = await syntaxPlan(view, doc, pos);
    if (!plan) return false;
    const at = plan.occurrences
      .map((o) => rangeToOffsets(view.state.doc, o.range))
      .find((o) => o.from <= part.from && part.to <= o.to);
    if (!at) return false;
    await commitSyntaxRename(
      view,
      doc,
      plan,
      spliceName(plan.symbol.name, part.from - at.from, word.length, replacement),
    );
    return true;
  };
  let range;
  try {
    range = await lspRequest(() => commands.lspPrepareRename(doc.doc, pos));
  } catch (e) {
    if (isCancelled(e)) return;
    if (!(await viaSyntax())) refuse("no language server can rename this symbol");
    return;
  }
  if (!range) {
    if (!(await viaSyntax())) refuse("this element can't be renamed");
    return;
  }
  const { from, to } = rangeToOffsets(view.state.doc, range);
  if (from > part.from || part.to > to) {
    refuse("the word is not part of a renamable name");
    return;
  }
  const oldName = view.state.sliceDoc(from, to);
  await finishRename(view, doc, pos, oldName, spliceName(oldName, part.from - from, word.length, replacement));
}

/** This file's other occurrences of the symbol (document highlights with the same text). */
async function linkedOccurrences(
  view: EditorView,
  doc: number,
  pos: Pos,
  primary: Span,
  name: string,
): Promise<Span[]> {
  let highlights;
  try {
    highlights = await lspRequest(() => commands.lspDocumentHighlights(doc, pos));
  } catch {
    return [];
  }
  const text = view.state.doc;
  return linkedSpans(
    highlights.map((h) => rangeToOffsets(text, h.range)),
    primary,
    (s) => text.sliceString(s.from, s.to) === name,
  );
}

/** Occurrence spans other than `primary`, sorted, without overlaps, that `accept` keeps. */
export function linkedSpans(spans: readonly Span[], primary: Span, accept: (s: Span) => boolean): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    if (s.to > primary.from && s.from < primary.to) continue;
    if (s.from >= s.to || !accept(s)) continue;
    const last = out[out.length - 1];
    if (last && s.from < last.to) continue;
    out.push(s);
  }
  return out;
}

async function commitInplace(view: EditorView, doc: EditorDocContext, pos: Pos, oldName: string, newName: string) {
  if (!newName.trim() || newName === oldName) return;
  // The server renames from the original text, which the session just restored.
  await whenSynced(view);
  await finishRename(view, doc, pos, oldName, newName);
}

async function finishRename(view: EditorView, doc: EditorDocContext, pos: Pos, oldName: string, newName: string) {
  if (!newName || newName === oldName) return;
  let edit: WorkspaceEdit;
  try {
    edit = await lspRequest(() => commands.lspRename(doc.doc, pos, newName));
  } catch (e) {
    reportLspError(view, e, true);
    return;
  }
  const summary = summarizeWorkspaceEdit(edit);
  if (!summary.files) {
    if (await hasSyntaxErrors(doc.doc)) {
      const plan = await syntaxPlan(view, doc, pos);
      if (plan && plan.symbol.name === oldName) {
        await commitSyntaxRename(view, doc, plan, newName);
        return;
      }
    }
    showHint(view, "Nothing to rename");
    return;
  }
  if (!needsPreview(summary)) {
    await applyEdit(view, edit);
    return;
  }
  openPopup({
    kind: "preview",
    title: tx`Rename '${oldName}' to '${newName}'`,
    summary,
    confirmLabel: "Do Refactor",
    onConfirm: () => void applyEdit(view, edit),
  });
}

// ---------------------------------------------------------------------------
// Syntax-based local rename

/** The local rename plan at `pos`, or null when the element is not a local the fallback may rename. */
async function syntaxPlan(view: EditorView, doc: EditorDocContext, pos: Pos): Promise<LocalRenamePlan | null> {
  try {
    await whenSynced(view);
    const result = await planLocalRename(doc, pos);
    return result.kind === "plan" ? result.plan : null;
  } catch (e) {
    if (!isCancelled(e)) console.debug("[syntax] rename fallback", e);
    return null;
  }
}

/** Opens the rename popup for a syntax-based local rename. False when the fallback can't help. */
async function startSyntaxRename(view: EditorView, doc: EditorDocContext, pos: Pos, cause?: unknown): Promise<boolean> {
  let result;
  try {
    await whenSynced(view);
    result = await planLocalRename(doc, pos);
  } catch (e) {
    if (!isCancelled(e)) console.debug("[syntax] rename fallback", e);
    return false;
  }
  if (result.kind === "unsupported") return false;
  if (result.kind === "refused") {
    const reason = isUnavailable(cause) ? unavailableText(cause) : cause instanceof Error ? cause.message : null;
    showHint(view, reason ? `${reason}. ${result.message}` : result.message);
    return true;
  }
  const { plan } = result;
  const at = plan.occurrences.find((o) => comparePos(o.range.start, pos) <= 0 && comparePos(pos, o.range.end) <= 0);
  openPopup({
    kind: "rename",
    anchor: caretAnchor(view, rangeToOffsets(view.state.doc, (at ?? plan.occurrences[0]!).range).from),
    title: tx`Rename '${plan.symbol.name}'`,
    initial: plan.symbol.name,
    note: `${SYNTAX_NOTE}: local occurrences only`,
    onSubmit: (newName) => void commitSyntaxRename(view, doc, plan, newName),
  });
  return true;
}

/** Applies a local rename in place, asking first when the syntax answer is not certain. */
export async function commitSyntaxRename(
  view: EditorView,
  doc: EditorDocContext,
  plan: LocalRenamePlan,
  newName: string,
) {
  const oldName = plan.symbol.name;
  if (!newName || newName === oldName) return;
  if (VALID_NAME.test(oldName) && !VALID_NAME.test(newName)) {
    showHint(view, `'${newName}' is not a valid identifier`, { tone: "error" });
    return;
  }
  const state = view.state;
  let risks: string[];
  try {
    risks = await renameRisks(doc.doc, plan, newName);
  } catch (e) {
    if (isCancelled(e)) return;
    risks = ["The name could not be checked for clashes."];
  }
  const apply = () => {
    if (view.state.doc !== state.doc) {
      showHint(view, "The file changed; rename cancelled", { tone: "warning" });
      return;
    }
    const changes = renameChanges(view.state.doc, plan, newName);
    if (!changes) {
      showHint(view, "The file changed; rename cancelled", { tone: "warning" });
      return;
    }
    view.dispatch({ changes, userEvent: "rename", scrollIntoView: true });
    showHint(view, `${SYNTAX_NOTE}: renamed ${changes.length} ${changes.length === 1 ? "occurrence" : "occurrences"}`, {
      timeout: 2500,
    });
  };
  if (!risks.length) {
    apply();
    return;
  }
  const occurrences: PreviewOccurrence[] = plan.occurrences.map((o) => {
    const { from, to } = rangeToOffsets(state.doc, o.range);
    const line = state.doc.lineAt(from);
    return { line: line.number - 1, text: line.text, from: from - line.from, to: Math.min(to, line.to) - line.from };
  });
  openPopup({
    kind: "preview",
    title: tx`Rename '${oldName}' to '${newName}'`,
    summary: {
      files: 1,
      occurrences: occurrences.length,
      hasFileOperations: false,
      entries: [{ path: doc.path, edits: occurrences.length }],
    },
    warnings: [...risks, `${SYNTAX_NOTE}. Only the occurrences below will be renamed.`],
    occurrences,
    confirmLabel: "Rename Anyway",
    onConfirm: apply,
  });
}
