/**
 * Safe Delete (⌘⌦): resolves the declaration at the caret (LSP definition +
 * document symbols; the tree-sitter structure service for local declarations
 * only), searches its usages (LSP references, the declaration's own body
 * excluded) once the user confirmed ("Delete 'x'?", optionally searching
 * comments and strings too), then deletes it — with attached doc comments / annotations and
 * the trailing blank line — as one undo step, or, when it is still used,
 * asks like IDEA: "Usages Detected" → View Usages / Delete Anyway / Cancel.
 *
 * Files (project view): references to the file's top-level symbols from other
 * files, when the language server can answer (`fileUsages`).
 */
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import type { LocalSymbol, Location, OutlineItem, Pos, Range, SyntaxNode } from "@/bindings";
import { call, commands, isCancelled, isTauri, nextRequestId, unavailableText } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { basename } from "@/platform/project";
import { editorsFor, whenSynced, type EditorDocContext } from "@/editor/api";
import { structure } from "@/editor/structure";
import { docOf, isUnavailable, lspRequest } from "@/editor/lsp/lsp";
import { comparePos, offsetToPos, rangeContains, rangeToOffsets } from "@/editor/lsp/positions";
import { showHint } from "@/editor/lsp/hint";
import { ask, confirmChecked } from "@/workbench/messages";
import { openPopup, type PreviewOccurrence } from "@/editor/lsp/popupStore";
import { cannotPerform } from "./catalog";
import { cancelled, languageName } from "./query";
import { tx } from "@/platform/i18n";

// ---------------------------------------------------------------------------
// Deletion range (pure)

export interface CommentSyntax {
  line: string | null;
  block: [string, string] | null;
}

const C_LIKE: CommentSyntax = { line: "//", block: ["/*", "*/"] };

/** Annotation / attribute / decorator lines that belong to the next declaration. */
const ANNOTATION = /^(@[A-Za-z_][\w.]*|#\[)/;

/**
 * The text to remove for a declaration spanning `from..to`: whole lines, plus
 * the doc comments / annotations directly above it and the trailing blank
 * line (or the blank line above it when nothing follows in its block). Null
 * when the declaration shares a line with other code (e.g. `int a, b;`).
 */
export function deletionRange(
  doc: Text,
  from: number,
  to: number,
  comments: CommentSyntax = C_LIKE,
): { from: number; to: number } | null {
  const first = doc.lineAt(from);
  const last = doc.lineAt(Math.max(from, to));
  if (doc.sliceString(first.from, from).trim()) return null;
  const rest = doc.sliceString(to, last.to).trim();
  const restOk =
    !rest ||
    /^[;,]$/.test(rest) ||
    (!!comments.line &&
      (rest.startsWith(comments.line) ||
        (/^[;,]\s*/.test(rest) && rest.replace(/^[;,]\s*/, "").startsWith(comments.line))));
  if (!restOk) return null;

  // Attached comments and annotations above (no blank line in between).
  let startLine = first.number;
  const block = comments.block;
  for (let n = first.number - 1; n >= 1; n--) {
    const text = doc.line(n).text.trim();
    if (!text) break;
    if (block && text.endsWith(block[1])) {
      let open = n;
      while (open >= 1 && !doc.line(open).text.includes(block[0])) open--;
      if (open < 1 || doc.line(open).text.trim().indexOf(block[0]) !== 0) break;
      startLine = open;
      n = open;
      continue;
    }
    if ((comments.line && text.startsWith(comments.line)) || ANNOTATION.test(text)) {
      startLine = n;
      continue;
    }
    break;
  }

  let start = doc.line(startLine).from;
  let end = last.to;
  const blank = (n: number) => n >= 1 && n <= doc.lines && !doc.line(n).text.trim();
  if (last.number < doc.lines) {
    end = last.to + 1;
    const next = last.number + 1;
    if (blank(next) && next < doc.lines) end = doc.line(next).to + 1;
    else if (blank(next)) end = doc.line(next).to;
    else if (blank(startLine - 1) && /^[}\])]|^end\b/.test(doc.line(next).text.trim()))
      start = doc.line(startLine - 1).from;
  } else if (startLine > 1) {
    // Last line: take the line break before it (and a blank line above).
    start = doc.line(blank(startLine - 1) && startLine > 2 ? startLine - 2 : startLine - 1).to;
  }
  return { from: start, to: end };
}

// ---------------------------------------------------------------------------
// Declaration at the caret

export interface SafeDeleteTarget {
  name: string;
  /** "Function", "Class", "Variable"… for messages. */
  kind: string;
  /** The declaring identifier (references are asked there). */
  at: Pos;
  /** Declaration extent in the document it was resolved against. */
  range: Range;
  /** Resolved from the syntax tree (no language server): usages are the local's references. */
  local: LocalSymbol | null;
}

export type Resolution = { status: "ok"; target: SafeDeleteTarget } | { status: "refused"; reason: string };

const KIND_LABEL: Record<string, string> = {
  enumMember: "Enum constant",
  typeParameter: "Type parameter",
  typeAlias: "Type alias",
  var: "Variable",
  function: "Function",
  import: "Import",
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Innermost outline item whose name range contains `pos`. */
export function outlineItemAt(items: readonly OutlineItem[], pos: Pos): OutlineItem | null {
  for (const item of items) {
    if (!rangeContains(item.range, pos)) continue;
    const inner = outlineItemAt(item.children, pos);
    if (inner) return inner;
    if (rangeContains(item.selection_range, pos)) return item;
  }
  return null;
}

const UNDELETABLE = new Set(["file", "package", "namespace"]);

const DECLARATION_STATEMENT =
  /declaration|assignment|^let|local|^var|^const|import|^use|expression_statement|property|short_var|definition$/;
const COMPOUND_STATEMENT = /^(for|while|if|with|try|catch|switch|match|do|loop|foreach|enhanced_for|case)/;
const FUNCTION_STATEMENT = /function|method|^def|^fn|func|procedure/;

/** Declaration statement of a syntax-resolved local, or why it can't be deleted on its own. */
export function localDeclaration(doc: Text, symbol: LocalSymbol, statement: SyntaxNode | null): Range | string {
  if (symbol.kind === "parameter") return "Deleting a parameter changes its call sites; use Change Signature";
  if (symbol.kind === "label" || symbol.kind === "type" || symbol.kind === "macro")
    return "Caret should be on a variable or function declaration";
  if (!symbol.certain) return `'${symbol.name}' is declared more than once in this scope`;
  if (!statement || !rangeContains(statement.range, symbol.definition.start))
    return "The declaration could not be determined";
  const kind = statement.kind;
  if (symbol.kind === "function") {
    return FUNCTION_STATEMENT.test(kind) ? statement.range : "The declaration could not be determined";
  }
  if (COMPOUND_STATEMENT.test(kind) || !DECLARATION_STATEMENT.test(kind))
    return `'${symbol.name}' is not declared by a separate statement`;
  const { from, to } = rangeToOffsets(doc, statement.range);
  const defEnd = rangeToOffsets(doc, symbol.definition).to;
  // Up to the initializer, the statement must declare only this name (no `a, b` / destructuring).
  const after = doc.sliceString(defEnd, to);
  let declarator = doc.sliceString(from, defEnd) + after.slice(0, Math.max(0, after.search(/=|;|$/)));
  for (let i = 0; i < 5; i++) declarator = declarator.replace(/<[^<>]*>/g, "");
  if (/[,([{]/.test(declarator)) return "The declaration declares other names too";
  return statement.range;
}

async function resolveTarget(view: EditorView, ctx: EditorDocContext): Promise<Resolution> {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const pos = offsetToPos(doc, head);
  const word = view.state.wordAt(head);
  if (!word) return { status: "refused", reason: "Caret should be on a symbol" };
  const name = view.state.sliceDoc(word.from, word.to);

  let lsp = true;
  let defPos = pos;
  try {
    const locs = await lspRequest(() => commands.lspGoto(ctx.doc, pos, "definition"));
    const here = locs.find((l) => l.path === ctx.path);
    if (here) defPos = here.range.start;
    else if (locs.length) {
      return { status: "refused", reason: `'${name}' is declared in ${basename(locs[0]!.path)}; Safe Delete it there` };
    }
  } catch (e) {
    if (isCancelled(e)) throw e;
    lsp = false;
  }

  const outline = await lspRequest(() => commands.docOutline(ctx.doc)).catch(() => [] as OutlineItem[]);
  const item = outlineItemAt(outline, defPos);
  if (item && !UNDELETABLE.has(item.kind)) {
    if (lsp)
      return {
        status: "ok",
        target: {
          name: item.name,
          kind: kindLabel(item.kind),
          at: item.selection_range.start,
          range: item.range,
          local: null,
        },
      };
  }

  const locals = await structure.locals(ctx.doc, defPos).catch((e: unknown) => {
    if (isCancelled(e)) throw e;
    return null;
  });
  if (locals?.status === "local") {
    const { symbol } = locals;
    const ranges = await structure.structuralRanges(ctx.doc, symbol.definition.start).catch(() => null);
    const decl = localDeclaration(doc, symbol, ranges?.statement ?? null);
    if (typeof decl === "string") return { status: "refused", reason: decl };
    return {
      status: "ok",
      target: {
        name: symbol.name,
        kind: kindLabel(symbol.kind === "other" ? "variable" : symbol.kind),
        at: symbol.definition.start,
        range: decl,
        local: lsp ? null : symbol,
      },
    };
  }
  if (!lsp) {
    const lang = await languageName(ctx.language);
    return {
      status: "refused",
      reason: `The language server for ${lang} is not available; only local declarations can be deleted safely without it`,
    };
  }
  return {
    status: "refused",
    reason: item ? `'${name}' can't be deleted` : "Caret should be on the name of a declaration",
  };
}

/** LSP references to the target, its own declaration excluded. */
async function findUsages(ctx: EditorDocContext, target: SafeDeleteTarget): Promise<Location[]> {
  const outside = (path: string, range: Range) =>
    path !== ctx.path ||
    comparePos(range.start, target.range.start) < 0 ||
    comparePos(range.start, target.range.end) > 0;
  if (target.local)
    return target.local.references.filter((r) => outside(ctx.path, r)).map((range) => ({ path: ctx.path, range }));
  const { locations: refs } = await lspRequest(() =>
    commands.lspReferences(nextRequestId(), ctx.doc, target.at, false, true),
  );
  return refs.filter((l) => outside(l.path, l.range));
}

// ---------------------------------------------------------------------------
// Usages Detected dialog

export type UsagesAnswer = "view" | "delete" | "cancel";

/** `subject`: "Function 'foo'", "File 'a.ts'", "3 files" (`plural`). */
export function usagesMessage(
  subject: string,
  usages: readonly Location[],
  plural = false,
): { message: string; detail: string } {
  const n = usages.length;
  const files = new Set(usages.map((u) => u.path)).size;
  const where = files > 1 ? tx` (in ${files} files)` : "";
  let detail: string;
  if (plural)
    detail =
      n === 1
        ? tx`${subject} have ${n} usage that is not safe to delete${where}.`
        : tx`${subject} have ${n} usages that are not safe to delete${where}.`;
  else
    detail =
      n === 1
        ? tx`${subject} has ${n} usage that is not safe to delete${where}.`
        : tx`${subject} has ${n} usages that are not safe to delete${where}.`;
  return { message: n === 1 ? tx`${n} usage found` : tx`${n} usages found`, detail };
}

/** IDEA's "Usages Detected" question; resolves "cancel" when dismissed. */
export async function askUsagesDetected(
  subject: string,
  usages: readonly Location[],
  plural = false,
): Promise<UsagesAnswer> {
  const { message, detail } = usagesMessage(subject, usages, plural);
  const { button } = await ask({
    title: "Usages Detected",
    icon: "warning",
    body: `${message}\n${detail}`,
    buttons: [
      { id: "view", label: "View Usages", primary: true },
      { id: "delete", label: "Delete Anyway" },
    ],
  });
  return button === "view" || button === "delete" ? button : "cancel";
}

/** Opens the Find Usages tool window with `usages` (code-insight's `find.showUsageResults`). */
export function viewUsages(symbol: string, usages: readonly Location[]) {
  void executeAction("find.showUsageResults", { symbol, locations: usages });
}

// ---------------------------------------------------------------------------
// Editor action

async function commentSyntax(language: string): Promise<CommentSyntax> {
  if (!isTauri()) return C_LIKE;
  try {
    const info = (await commands.languages()).find((l) => l.id === language);
    if (info) return { line: info.lineComment, block: info.blockComment };
  } catch {
    /* default below */
  }
  return C_LIKE;
}

function applyDeletion(view: EditorView, docBefore: Text, target: SafeDeleteTarget, comments: CommentSyntax): boolean {
  if (view.state.doc !== docBefore) {
    showHint(view, "The file changed; Safe Delete cancelled", { tone: "warning" });
    return false;
  }
  const { from, to } = rangeToOffsets(docBefore, target.range);
  const del = deletionRange(docBefore, from, to, comments);
  if (!del) {
    showHint(view, cannotPerform(`'${target.name}' shares its line with other code`));
    return false;
  }
  view.dispatch({
    changes: { from: del.from, to: del.to },
    selection: { anchor: del.from },
    userEvent: "delete.safe",
    scrollIntoView: true,
  });
  return true;
}

let running: EditorView | null = null;
/** "Search in comments and strings", remembered like IDEA does (on by default). */
let searchInComments = true;

/**
 * Mentions of the name in this file's comments and strings: whole-word text
 * matches that are not identifier tokens, outside the declaration itself.
 */
export function textOccurrences(
  text: string,
  name: string,
  identifiers: readonly { from: number; to: number }[],
  exclude: { from: number; to: number },
): { from: number; to: number }[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?![\\p{L}\\p{N}_$])`, "gu");
  const ids = new Set(identifiers.map((o) => o.from));
  const out: { from: number; to: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = m.index;
    if (/[\p{L}\p{N}_$]$/u.test(text.slice(Math.max(0, from - 2), from))) continue;
    if (ids.has(from) || (from >= exclude.from && from < exclude.to)) continue;
    out.push({ from, to: from + name.length });
  }
  return out;
}

async function commentAndStringOccurrences(
  ctx: EditorDocContext,
  doc: Text,
  target: SafeDeleteTarget,
): Promise<{ from: number; to: number }[]> {
  let identifiers;
  try {
    identifiers = await structure.identifiers(ctx.doc, target.name);
  } catch (e) {
    if (isCancelled(e)) throw e;
    // Without a syntax tree comments can't be told from code.
    return [];
  }
  const ids = identifiers.map((o) => rangeToOffsets(doc, o.range));
  return textOccurrences(doc.toString(), target.name, ids, rangeToOffsets(doc, target.range));
}

/** No code usages, but mentions in comments / strings: show them before deleting (IDEA's preview). */
function previewTextOccurrences(
  ctx: EditorDocContext,
  doc: Text,
  target: SafeDeleteTarget,
  hits: readonly { from: number; to: number }[],
  apply: () => void,
) {
  const occurrences: PreviewOccurrence[] = hits.map((h) => {
    const line = doc.lineAt(h.from);
    return {
      line: line.number - 1,
      text: line.text,
      from: h.from - line.from,
      to: Math.min(h.to, line.to) - line.from,
    };
  });
  openPopup({
    kind: "preview",
    title: tx`Safe Delete ${target.kind} '${target.name}'`,
    summary: {
      files: 1,
      occurrences: occurrences.length,
      hasFileOperations: false,
      entries: [{ path: ctx.path, edits: occurrences.length }],
    },
    warnings: [
      `'${target.name}' is mentioned in comments or strings. The declaration will be deleted; these mentions stay.`,
    ],
    occurrences,
    confirmLabel: "Delete",
    onConfirm: apply,
  });
}

export async function safeDelete(view: EditorView): Promise<void> {
  const ctx = docOf(view);
  if (!ctx) return;
  if (ctx.readOnly) {
    showHint(view, "The file is read-only");
    return;
  }
  if (running === view) return;
  running = view;
  try {
    await whenSynced(view);
    const docBefore = view.state.doc;
    const selBefore = view.state.selection;
    const resolved = await resolveTarget(view, ctx);
    if (resolved.status === "refused") {
      showHint(view, cannotPerform(resolved.reason));
      return;
    }
    const { target } = resolved;
    const comments = await commentSyntax(ctx.language);
    // Validate before asking: a declaration that can't be removed by lines is refused up front.
    const { from, to } = rangeToOffsets(docBefore, target.range);
    if (!deletionRange(docBefore, from, to, comments)) {
      showHint(view, cannotPerform(`'${target.name}' shares its line with other code`));
      return;
    }
    // IDEA always confirms first; usages are searched after OK.
    const confirmed = await confirmChecked({
      title: "Safe Delete",
      message: tx`Delete ${target.kind} '${target.name}'?`,
      ok: "OK",
      checkbox: "Search in comments and strings",
      checked: searchInComments,
    });
    if (!confirmed) {
      view.focus();
      return;
    }
    searchInComments = confirmed.checked;
    if (view.state.doc !== docBefore || !view.state.selection.eq(selBefore)) return;
    const [usages, textHits] = await Promise.all([
      findUsages(ctx, target),
      confirmed.checked ? commentAndStringOccurrences(ctx, docBefore, target) : Promise.resolve([]),
    ]);
    if (view.state.doc !== docBefore) return;
    if (usages.length) {
      const answer = await askUsagesDetected(tx`${target.kind} '${target.name}'`, usages);
      if (answer === "view") viewUsages(target.name, usages);
      else if (answer === "delete") applyDeletion(view, docBefore, target, comments);
      else view.focus();
      return;
    }
    if (textHits.length) {
      previewTextOccurrences(ctx, docBefore, target, textHits, () => applyDeletion(view, docBefore, target, comments));
      return;
    }
    applyDeletion(view, docBefore, target, comments);
  } catch (e) {
    if (isCancelled(e)) return;
    showHint(
      view,
      isUnavailable(e)
        ? cannotPerform(unavailableText(e, "No language server is available"))
        : cannotPerform(errorText(e)),
    );
  } finally {
    running = null;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Files (project view)

export type FileUsages =
  | { status: "ok"; usages: Location[] }
  /** The language server can't tell (none running, no document symbols…). */
  | { status: "unsupported"; reason: string };

/** At most this many top-level symbols per file are searched. */
const MAX_SYMBOLS = 60;

async function withDoc<T>(path: string, fn: (doc: number) => Promise<T>): Promise<T> {
  const open = editorsFor(path)[0];
  if (open) return fn(open.ctx.doc);
  const info = await lspRequest(() => commands.docOpen(path));
  try {
    return await fn(info.id);
  } finally {
    void commands.docClose(info.id);
  }
}

/**
 * References from outside `paths` to the top-level symbols the files declare.
 * Unsupported when no reference search could run for any of them.
 */
export async function fileUsages(paths: readonly string[], signal?: AbortSignal): Promise<FileUsages> {
  if (!isTauri()) return { status: "unsupported", reason: "No language server available" };
  const deleted = new Set(paths);
  const found = new Map<string, Location>();
  let searched = false;
  let reason = "No language server supports usage search for these files";
  for (const path of paths) {
    if (signal?.aborted) throw cancelled();
    try {
      await withDoc(path, async (doc) => {
        const outline = await call(commands.docOutline(doc));
        for (const item of outline.slice(0, MAX_SYMBOLS)) {
          if (signal?.aborted) return;
          let refs: Location[];
          try {
            // Every symbol of every file: the server's own scope (a project search each would be too slow).
            refs = (
              await lspRequest(() =>
                commands.lspReferences(nextRequestId(), doc, item.selection_range.start, false, false),
              )
            ).locations;
          } catch (e) {
            if (isUnavailable(e)) {
              reason = errorText(e);
              return;
            }
            continue;
          }
          searched = true;
          for (const r of refs) {
            if (deleted.has(r.path)) continue;
            found.set(`${r.path}:${r.range.start.line}:${r.range.start.col}`, r);
          }
        }
      });
    } catch (e) {
      if (isCancelled(e)) throw e;
      reason = errorText(e);
    }
  }
  if (signal?.aborted) throw cancelled();
  return searched ? { status: "ok", usages: [...found.values()] } : { status: "unsupported", reason };
}
