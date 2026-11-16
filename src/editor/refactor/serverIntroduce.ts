/**
 * Introduce Variable / Constant / Field / Parameter and Extract Method through
 * the language server, with IDEA's interaction around the server's edit:
 *  - with only a caret, the expression is chosen first (each candidate is
 *    highlighted while the chooser moves) and selected before the server is
 *    asked, so it extracts exactly that expression;
 *  - when the server offers both a "this occurrence" and an "all
 *    occurrences" variant, IDEA's "Multiple occurrences found" chooser picks;
 *  - after the edit the introduced name is renamed in place, with name
 *    suggestions from the expression (↑ / ↓).
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CodeAction, SyntaxNode } from "@/bindings";
import { isCancelled } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { whenSynced } from "@/editor/api";
import { structure, type ExpressionAt } from "@/editor/structure";
import { docOf } from "@/editor/lsp/lsp";
import { offsetsToRange, rangeToOffsets } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { applyCodeAction } from "@/editor/lsp/intentions";
import { putSuggestion, startInplaceRename, type Span } from "@/editor/lsp/inplaceRename";
import { clearTemporaryHighlight, highlightRanges } from "@/editor/lsp/tempHighlight";
import type { RefactoringId } from "./catalog";
import { expressionCandidates, expressionPreview } from "./introduce";
import { findTextOccurrences } from "./occurrences";
import { isIdentifier, isKeyword, suggestNames, uniqueNames } from "./names";
import { tx } from "@/platform/i18n";

/** Refactorings that take an expression (chosen first when nothing is selected). */
export const EXPRESSION_REFACTORINGS: ReadonlySet<RefactoringId> = new Set([
  "extractVariable",
  "extractConstant",
  "extractField",
  "extractParameter",
]);

/** Refactorings whose result is a new name renamed in place afterwards. */
const NAMING_REFACTORINGS: ReadonlySet<RefactoringId> = new Set([...EXPRESSION_REFACTORINGS, "extractMethod"]);

export function introducesName(id: RefactoringId | null): boolean {
  return !!id && NAMING_REFACTORINGS.has(id);
}

// ---------------------------------------------------------------------------
// Expression chooser

/**
 * With an empty selection: selects the expression at the caret (asking which
 * one when there are several) and then runs `then`. False when there is no
 * expression to choose (the caller goes on as before).
 */
export async function chooseExpressionFirst(view: EditorView, then: () => unknown): Promise<boolean> {
  const ctx = docOf(view);
  const sel = view.state.selection.main;
  if (!ctx || !sel.empty) return false;
  const support = await structure.support(ctx.language).catch(() => null);
  if (!support?.tree) return false;
  await whenSynced(view);
  const doc = view.state.doc;
  let at: ExpressionAt;
  try {
    at = await structure.expressionAt(ctx.doc, offsetsToRange(doc, sel.from, sel.to));
  } catch (e) {
    if (isCancelled(e)) return true;
    return false;
  }
  if (view.state.doc !== doc || !view.state.selection.main.eq(sel)) return true;
  const candidates = expressionCandidates(doc, at);
  if (!candidates.length) return false;
  const select = (node: SyntaxNode) => {
    if (view.state.doc !== doc) {
      showHint(view, "The document changed; invoke the refactoring again");
      return;
    }
    const { from, to } = rangeToOffsets(doc, node.range);
    view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true });
    view.focus();
    void then();
  };
  if (candidates.length === 1) {
    select(candidates[0]!);
    return true;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, sel.head),
    title: "Expressions",
    items: candidates.map((c, i) => ({
      id: `${i}`,
      label: expressionPreview(doc.sliceString(rangeToOffsets(doc, c.range).from, rangeToOffsets(doc, c.range).to)),
      onActive: () => highlightRanges(view, [rangeToOffsets(doc, c.range)]),
      run: () => select(c),
    })),
    onClose: () => clearTemporaryHighlight(view),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Occurrences chooser

const ALL_OCCURRENCES = /\b(all|every) (the )?occurrences?\b|\breplace all\b/i;

/** The single-occurrence / all-occurrences pair among a refactoring's actions, if the server offers both. */
export function occurrenceVariants(actions: readonly CodeAction[]): { one: CodeAction; all: CodeAction } | null {
  const all = actions.filter((a) => ALL_OCCURRENCES.test(a.title));
  const one = actions.filter((a) => !ALL_OCCURRENCES.test(a.title));
  return all.length === 1 && one.length === 1 ? { one: one[0]!, all: all[0]! } : null;
}

/**
 * IDEA's "Multiple occurrences found" for a server that offers both variants,
 * applying the single-occurrence one directly when the selected text occurs only once;
 * false when it does not (the caller applies / lists the actions as before).
 */
export function chooseOccurrences(view: EditorView, actions: readonly CodeAction[], id: RefactoringId): boolean {
  const variants = occurrenceVariants(actions);
  if (!variants) return false;
  const state = view.state;
  const sel = state.selection.main;
  const text = state.sliceDoc(sel.from, sel.to);
  const occurrences = text.trim() ? findTextOccurrences(state.doc.toString(), 0, state.doc.length, text, 200) : [];
  const n = occurrences.length;
  if (n === 1) {
    void applyIntroduceAction(view, variants.one, id);
    return true;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, sel.head),
    title: "Multiple occurrences found",
    items: [
      {
        id: "one",
        label: "Replace this occurrence only",
        onActive: () => highlightRanges(view, [{ from: sel.from, to: sel.to }]),
        run: () => applyIntroduceAction(view, variants.one, id),
      },
      {
        id: "all",
        label: n > 1 ? tx`Replace all ${n} occurrences` : "Replace all occurrences",
        onActive: () => highlightRanges(view, n ? occurrences : [{ from: sel.from, to: sel.to }]),
        run: () => applyIntroduceAction(view, variants.all, id),
      },
    ],
    onClose: () => clearTemporaryHighlight(view),
  });
  return true;
}

// ---------------------------------------------------------------------------
// The introduced name

const WORD = /[\p{L}\p{N}_$]/u;
const TOKEN = /[\p{L}_$][\p{L}\p{N}_$]*|\S/gu;

interface Token {
  text: string;
  from: number;
}

function tokens(text: string, offset: number): Token[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ text: m[0], from: offset + m.index! }));
}

/** Tokens of `after` that are not part of the longest common token subsequence with `before`. */
function insertedTokens(before: Token[], after: Token[]): Token[] {
  const n = before.length;
  const m = after.length;
  if (n * m > 4_000_000) return after;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[at(i, j)] =
        before[i]!.text === after[j]!.text
          ? lcs[at(i + 1, j + 1)]! + 1
          : Math.max(lcs[at(i + 1, j)]!, lcs[at(i, j + 1)]!);
  const out: Token[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && before[i]!.text === after[j]!.text) {
      i++;
      j++;
    } else if (i < n && lcs[at(i + 1, j)]! >= lcs[at(i, j + 1)]!) i++;
    else out.push(after[j++]!);
  }
  return out;
}

/** Names servers give new declarations before the user names them. */
const SERVER_DEFAULT = /^(new[A-Z_]\w*|newLocal\w*|var_name\d*|fun_name\d*|extracted\w*|new_\w+|value\d*)$/;

/**
 * The name a refactoring introduced, and every place the edit wrote it, from
 * the text before and after (servers may apply the edit through a command,
 * so the edit itself is not always known). Null when no new name appears at
 * least twice (declaration and use).
 */
export function introducedName(before: string, after: string): { name: string; spans: Span[] } | null {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // Whole words at both ends of the changed region.
  while (start > 0 && WORD.test(after[start - 1]!)) start--;
  let afterTo = after.length - end;
  let beforeTo = before.length - end;
  while (afterTo < after.length && WORD.test(after[afterTo]!)) {
    afterTo++;
    beforeTo++;
  }
  const inserted = insertedTokens(
    tokens(before.slice(start, beforeTo), start),
    tokens(after.slice(start, afterTo), start),
  );
  const byName = new Map<string, Span[]>();
  for (const t of inserted) {
    if (!WORD.test(t.text[0]!) || !isIdentifier(t.text) || isKeyword(t.text)) continue;
    let list = byName.get(t.text);
    if (!list) byName.set(t.text, (list = []));
    list.push({ from: t.from, to: t.from + t.text.length });
  }
  let best: { name: string; spans: Span[] } | null = null;
  const score = (name: string, spans: Span[]) => (SERVER_DEFAULT.test(name) ? 1000 : 0) + spans.length;
  for (const [name, spans] of byName) {
    if (spans.length < 2) continue;
    if (!best || score(name, spans) > score(best.name, best.spans)) best = { name, spans };
  }
  if (!best) return null;
  // The server picked a name free in scope, so every plain (non-member) use in the changed
  // region is the new one; the token alignment alone may pair one with an old member name.
  const name = best.name;
  const spans: Span[] = [];
  for (const t of tokens(after.slice(start, afterTo), start)) {
    if (t.text !== name) continue;
    const lead = after.slice(Math.max(0, t.from - 2), t.from);
    if (/(\.|->|::)\s*$/.test(lead) && !best.spans.some((s) => s.from === t.from)) continue;
    spans.push({ from: t.from, to: t.from + name.length });
  }
  return { name, spans };
}

async function nameSuggestions(view: EditorView, id: RefactoringId, expression: { kind: string; text: string } | null) {
  const ctx = docOf(view);
  if (!ctx || !expression || !EXPRESSION_REFACTORINGS.has(id)) return [];
  const raw = suggestNames({ ...expression, language: ctx.language, constant: id === "extractConstant" });
  if (!raw.length) return [];
  return uniqueNames(raw, async (name) => {
    const found = await structure.identifiers(ctx.doc, name);
    return found.some((o) => !o.qualified);
  });
}

async function expressionInfo(view: EditorView): Promise<{ kind: string; text: string } | null> {
  const ctx = docOf(view);
  const sel = view.state.selection.main;
  if (!ctx || sel.empty) return null;
  const text = view.state.sliceDoc(sel.from, sel.to);
  try {
    const at = await structure.expressionAt(ctx.doc, offsetsToRange(view.state.doc, sel.from, sel.to));
    return { kind: at.exact && at.expression ? at.expression.kind : "", text };
  } catch {
    return { kind: "", text };
  }
}

async function docChange(view: EditorView, before: EditorView["state"]["doc"], ms = 1500): Promise<boolean> {
  for (let waited = 0; waited < ms && view.state.doc === before; waited += 20)
    await new Promise((r) => setTimeout(r, 20));
  return view.state.doc !== before;
}

/**
 * Applies a server extract / introduce action, then renames the introduced
 * name in place (as IDEA does), with name suggestions for an expression.
 */
export async function applyIntroduceAction(view: EditorView, action: CodeAction, id: RefactoringId): Promise<void> {
  const expression = await expressionInfo(view);
  const before = view.state.doc;
  await applyCodeAction(view, action);
  if (!(await docChange(view, before))) return;
  // The server's edit may arrive in more than one transaction.
  await new Promise((r) => setTimeout(r, 30));
  const doc = view.state.doc;
  const found = introducedName(before.toString(), doc.toString());
  if (!found) return;
  const suggestions = await nameSuggestions(view, id, expression).catch(() => [] as string[]);
  if (view.state.doc !== doc) return;
  const caret = view.state.selection.main.head;
  // The occurrence at the caret (where the expression was), else the declaration.
  const primary = found.spans.find((s) => s.from <= caret && caret <= s.to) ?? found.spans[0]!;
  const others = found.spans.filter((s) => s !== primary);
  const keys = shortcutLabel("refactor.rename");
  const names = suggestions.includes(found.name) ? suggestions : [...suggestions, found.name];
  view.focus();
  startInplaceRename(view, {
    primary,
    others,
    suggestions: names.length > 1 ? names : undefined,
    hint: keys ? tx`Press ${keys} to show dialog with more options` : "↵ to finish, Esc to keep the name",
    commit: (name) => renameIntroduced(view, [primary, ...others], found.name, name),
    dialog: (typed) =>
      openPopup({
        kind: "rename",
        anchor: caretAnchor(view, primary.from),
        title: tx`Rename '${found.name}'`,
        initial: typed,
        suggestions: names,
        onSubmit: (name) => renameIntroduced(view, [primary, ...others], found.name, name),
      }),
  });
  // As in IDEA the best suggestion replaces the server's placeholder name right away.
  if (suggestions[0] && suggestions[0] !== found.name) putSuggestion(view, suggestions[0]);
}

/** Writes `name` over the introduced name's occurrences (the session restored `current` there). */
export function renameIntroduced(view: EditorView, spans: readonly Span[], current: string, name: string) {
  if (!name || name === current) return;
  if (!isIdentifier(name) || isKeyword(name)) {
    showHint(view, `'${name}' is not a valid name; kept '${current}'`, { tone: "warning" });
    return;
  }
  const state = view.state;
  if (spans.some((s) => s.to > state.doc.length || state.sliceDoc(s.from, s.to) !== current)) {
    showHint(view, "The document changed; the name was not applied");
    return;
  }
  view.dispatch({
    changes: spans.map((s) => ({ ...s, insert: name })),
    userEvent: "refactor.rename",
    scrollIntoView: true,
  });
}
