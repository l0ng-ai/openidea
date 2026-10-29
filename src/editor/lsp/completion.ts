/**
 * Code completion backed by `lsp_completion`, rendered in IDEA's style: mono
 * rows with a kind letter, the label with the matched prefix emphasised, the
 * label detail, the type right-aligned and a footer hint bar. ↵ inserts, ⇥
 * replaces the rest of the identifier, documentation resolves lazily into the
 * side panel. Without a language server the editor's language-data sources
 * (keywords, local words) are used instead.
 */
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completeFromList,
  completionStatus,
  currentCompletions,
  pickedCompletion,
  selectedCompletion,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionInfo,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorSelection, Prec, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import {
  call,
  commands,
  isTauri,
  nextRequestId,
  type CompletionItem,
  type Markup,
  type RequestId,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  completionSymbolKind,
  identifierEnd,
  toCmCompletion,
  triggerCharacter,
  typeColumnText,
  withoutDuplicates,
} from "./completionItems";
import { lspSnippetToCm, snippetVariables } from "./snippet";
import { docOf, isUnavailable, lspDoc, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, posToOffset, textEditsToChanges } from "./positions";
import { isEmptyMarkup, renderCode, renderMarkup } from "./markdown";
import { selectableText } from "@/ui/selectableText";
import { iconNode } from "./iconMarkup";
import { parameterInfoOrLeave, triggerSignatureHelp } from "./signature";
import { featureBackoff } from "./availability";
import { pathCompletionSource } from "./fileReferences";
import { editorPrefs } from "@/platform/editorSettings";
import { tx } from "@/platform/i18n";
import { showHint } from "./hint";
import { inplaceRenameActive } from "./inplaceRename";

interface RequestContext {
  doc: number;
  path: string;
  language: string | null;
  /** Caret offset and document at request time; item ranges refer to these. */
  pos: number;
  text: Text;
}

interface LspCompletion extends Completion {
  lsp: CompletionItem;
  req: RequestContext;
  resolved?: CompletionItem;
}

const isLsp = (c: Completion): c is LspCompletion => "lsp" in c;

// ---------------------------------------------------------------------------
// Resolve (documentation, lazily computed edits)

const resolving = new WeakMap<CompletionItem, Promise<CompletionItem>>();
/** Items whose resolve has answered, for accepting them synchronously. */
const resolvedItems = new WeakMap<CompletionItem, CompletionItem>();

function resolveItem(doc: number, item: CompletionItem): Promise<CompletionItem> {
  if (item.data == null && !isEmptyMarkup(item.documentation)) return Promise.resolve(item);
  let p = resolving.get(item);
  if (!p) {
    p = lspRequest(() => commands.lspResolveCompletion(doc, item)).then(
      (r) => {
        resolvedItems.set(item, r);
        return r;
      },
      () => item,
    );
    resolving.set(item, p);
  }
  return p;
}

/**
 * Resolves the selected lookup item ahead of acceptance: some servers compute
 * its extra edits (rust-analyzer's `use` import) only on resolve, against the
 * text as it was, so resolving after the insertion finds nothing.
 */
const prefetchResolve = ViewPlugin.fromClass(
  class {
    private last: Completion | null = null;
    update(u: ViewUpdate) {
      const c = selectedCompletion(u.state);
      if (c === this.last) return;
      this.last = c;
      if (c && isLsp(c) && c.lsp.data != null && !c.lsp.additionalEdits.length) void resolveItem(c.req.doc, c.lsp);
    }
  },
);

/**
 * F1 in the lookup (IDEA's documentation popup next to the lookup): docs then
 * follow the selection until the lookup closes. Without the auto-popup setting
 * the info panel waits for this.
 */
let docsRequested = false;
const docWaiters = new Set<() => void>();

function renderInfo(c: LspCompletion): Promise<CompletionInfo> {
  const prefs = editorPrefs().completion;
  if (!prefs.showDocumentation && !docsRequested)
    return new Promise((resolve) => {
      const show = () => {
        docWaiters.delete(show);
        resolve(buildInfo(c, 0));
      };
      docWaiters.add(show);
    });
  return buildInfo(c, docsRequested ? 0 : Math.max(0, prefs.documentationDelay));
}

function buildInfo(c: LspCompletion, delay: number): Promise<CompletionInfo> {
  const wait = delay ? new Promise<void>((r) => setTimeout(r, delay)) : Promise.resolve();
  return Promise.all([resolveItem(c.req.doc, c.lsp), wait]).then(([item]) => {
    c.resolved = item;
    const hasDoc = !isEmptyMarkup(item.documentation);
    if (!hasDoc && !item.detail) return null;
    const dom = document.createElement("div");
    dom.className = `cm-lsp-completion-doc ${selectableText}`;
    if (item.detail) dom.appendChild(renderCode(item.detail, c.req.language, "cm-lsp-code cm-lsp-doc-signature"));
    if (hasDoc) dom.appendChild(renderMarkup(item.documentation!, c.req.language));
    return dom;
  });
}

function resetLookupDocs() {
  docsRequested = false;
  docWaiters.clear();
}

/**
 * F1 while the lookup is open: shows the selected item's docs beside it
 * (`shown`), or reports that they are already showing (`showing`) so the
 * caller can open them focused instead. `none` without an open lookup.
 */
export function showLookupDocs(view: EditorView): "shown" | "showing" | "none" {
  if (completionStatus(view.state) !== "active" || !selectedCompletion(view.state)) return "none";
  if (docsRequested || editorPrefs().completion.showDocumentation) return "showing";
  docsRequested = true;
  for (const show of [...docWaiters]) show();
  return "shown";
}

/** Documentation of the selected lookup item as markup (detail as a code block), or null. */
export async function selectedLookupDoc(view: EditorView): Promise<{ markup: Markup; language: string | null } | null> {
  const c = selectedCompletion(view.state);
  if (!c || !isLsp(c)) return null;
  const item = await resolveItem(c.req.doc, c.lsp);
  const parts: string[] = [];
  if (item.detail) parts.push("```" + (c.req.language ?? "") + "\n" + item.detail + "\n```");
  if (!isEmptyMarkup(item.documentation)) parts.push(item.documentation!.value);
  return parts.length ? { markup: { kind: "markdown", value: parts.join("\n\n") }, language: c.req.language } : null;
}

// ---------------------------------------------------------------------------
// Apply

/** Set by the ⇥ binding for the duration of `acceptCompletion`. */
let replaceMode = false;

function applyLsp(view: EditorView, completion: Completion, from: number, to: number) {
  applyLspCompletion(view, completion, from, to, replaceMode ? "replace" : "insert");
}

/** ↵ (`insert`) or ⇥ (`replace`: also overwrites the rest of the identifier). */
export function applyLspCompletion(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
  mode: "insert" | "replace",
) {
  if (!isLsp(completion)) return;
  const { req } = completion;
  const item = completion.resolved ?? resolvedItems.get(completion.lsp) ?? completion.lsp;
  const state = view.state;
  const delta = to - req.pos;
  const mapOld = (offset: number) =>
    Math.max(0, Math.min(state.doc.length, offset < req.pos ? offset : offset + delta));

  let start = from;
  let end = to;
  if (item.replaceRange) {
    start = Math.min(mapOld(posToOffset(req.text, item.replaceRange.start)), to);
    end = Math.max(mapOld(posToOffset(req.text, item.replaceRange.end)), to);
  }
  if (mode === "replace") {
    if (item.replaceRangeTab) end = Math.max(end, mapOld(posToOffset(req.text, item.replaceRangeTab.end)));
    else {
      const line = state.doc.lineAt(end);
      end = line.from + identifierEnd(line.text, end - line.from);
    }
  }

  const extra = textEditsToChanges(req.text, item.additionalEdits)
    .map((c) => ({ from: mapOld(c.from), to: mapOld(c.to), insert: c.insert }))
    .filter((c) => c.to <= start || c.from >= end);

  let insertedParens: ReturnType<typeof callParens> = null;
  let bareCall: number | null = null;
  if (item.isSnippet) {
    if (extra.length) {
      const tr = state.update({ changes: extra, userEvent: "input.complete" });
      view.dispatch(tr);
      start = tr.changes.mapPos(start, 1);
      end = tr.changes.mapPos(end, 1);
    }
    snippet(lspSnippetToCm(item.insertText, snippetVariables(req.path)))(view, completion, start, end);
    // A call snippet without a stop (`ArrayList<>()`): the caret goes inside until
    // signature help says there is nothing to pass.
    const head = view.state.selection.main.head;
    if (
      editorPrefs().completion.insertParentheses &&
      CALLABLE.has(item.kind ?? "") &&
      /\(\)$/.test(item.insertText) &&
      !/\$/.test(item.insertText) &&
      view.state.sliceDoc(head - 2, head) === "()"
    ) {
      view.dispatch({ selection: EditorSelection.cursor(head - 1) });
      bareCall = head - 1;
    }
  } else {
    const parens = editorPrefs().completion.insertParentheses
      ? callParens(item, state.doc.lineAt(start), start, end)
      : null;
    insertedParens = parens;
    const changes = state.changes([...extra, { from: start, to: end, insert: item.insertText + (parens ? "()" : "") }]);
    const caret = changes.mapPos(end, 1) - (parens === "inside" ? 1 : 0);
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(caret),
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
    });
  }

  if (item === completion.lsp && !item.additionalEdits.length && item.data != null)
    void applyLateEdits(view, completion, start);
  // Parameter info for a call left open, plain (`()` added here) or a server snippet (`fly(${1})`).
  const callSnippet = item.isSnippet && CALLABLE.has(item.kind ?? "") && /\(\$\{?\d/.test(item.insertText);
  // Unless the item's command asks for it itself (other commands, like jdtls's
  // `java.completion.onDidSelect`, are bookkeeping).
  const hintsCommand = item.command?.command === "editor.action.triggerParameterHints";
  if ((insertedParens === "inside" || callSnippet) && !hintsCommand) setTimeout(() => triggerSignatureHelp(view), 0);
  else if (bareCall !== null) void parameterInfoOrLeave(view, bareCall);
  runCommand(view, item);
}

const CALLABLE = new Set(["function", "method", "constructor"]);
/** Lines where a callable is named, not called (imports, `use` paths). */
const IMPORT_LINE = /^\s*(import|from|use|pub\s+use|export\s+\{|#include|require)\b/;

/**
 * Code Completion › Insert parentheses automatically: `()` after a function or
 * method name inserted as plain text (snippets bring their own), with the
 * caret `inside` unless the signature shows no parameters. Null when the
 * name is followed by `(` or an identifier, or names an import.
 */
export function callParens(
  item: Pick<CompletionItem, "kind" | "insertText" | "isSnippet" | "labelDetail" | "detail">,
  line: { from: number; text: string },
  start: number,
  end: number,
): "inside" | "after" | null {
  if (item.isSnippet || !item.kind || !CALLABLE.has(item.kind) || /[(<[{]/.test(item.insertText)) return null;
  const next = line.text.charAt(end - line.from);
  if (next && /[(\p{L}\p{N}_$]/u.test(next)) return null;
  if (IMPORT_LINE.test(line.text.slice(0, start - line.from))) return null;
  const sig = item.labelDetail ?? item.detail ?? "";
  return /^\s*\(\s*\)/.test(sig) || /^\s*fn\s*\(\s*\)|^\s*\(\)\s*(=>|->|:)/.test(sig) ? "after" : "inside";
}

/**
 * Some servers (tsserver auto-imports) only compute additional edits on
 * resolve. Apply those that lie before the insertion once they arrive, if the
 * text before it is unchanged.
 */
async function applyLateEdits(view: EditorView, c: LspCompletion, insertedAt: number) {
  const item = await resolveItem(c.req.doc, c.lsp);
  if (!item.additionalEdits.length || !view.dom.isConnected) return;
  const edits = textEditsToChanges(c.req.text, item.additionalEdits).filter(
    (e) => e.to <= Math.min(insertedAt, c.req.pos),
  );
  if (!edits.length) return;
  const limit = Math.max(...edits.map((e) => e.to));
  if (view.state.doc.sliceString(0, limit) !== c.req.text.sliceString(0, limit)) return;
  view.dispatch({ changes: edits, userEvent: "input.complete" });
}

/** Client-side commands handled by the editor itself (VS Code ids servers commonly send). */
const CLIENT_COMMANDS = new Set(["editor.action.triggerParameterHints", "editor.action.triggerSuggest"]);

function runCommand(view: EditorView, item: CompletionItem) {
  const command = item.command;
  if (!command?.command) return;
  const cmd = command.command;
  if (cmd === "editor.action.triggerParameterHints") setTimeout(() => triggerSignatureHelp(view), 0);
  else if (cmd === "editor.action.triggerSuggest") setTimeout(() => startCompletion(view), 0);
  else if (!CLIENT_COMMANDS.has(cmd) && !cmd.startsWith("editor.")) {
    const doc = docOf(view);
    // Server commands (auto-import, postfix…); resulting edits come back as workspace/applyEdit.
    if (doc)
      void lspRequest(() => commands.lspExecuteCommand(doc.doc, command)).catch((e: unknown) =>
        reportLspError(view, e, false),
      );
  }
}

// ---------------------------------------------------------------------------
// Source

const WORD_BEFORE = /[\p{L}\p{N}_$]+$/u;
const VALID_FOR = /^[\p{L}\p{N}_$]*$/u;

let inflight: RequestId | null = null;

function cancelInflight() {
  if (inflight !== null && isTauri()) void commands.cancelRequest(inflight);
  inflight = null;
}

/** Language-data completion sources (keywords etc.), used when no server answers. */
async function fallback(ctx: CompletionContext): Promise<CompletionResult | null> {
  const sources = ctx.state.languageDataAt<CompletionSource | readonly (string | Completion)[]>(
    "autocomplete",
    ctx.pos,
  );
  for (const s of sources) {
    const source = typeof s === "function" ? s : completeFromList(s);
    const r = await source(ctx);
    if (r) return r;
  }
  return null;
}

export function makeCompletion(item: CompletionItem, req: RequestContext): LspCompletion {
  // The lookup handles commit characters itself (focused lookups only, see `lookupKeys`).
  const { commitCharacters: _server, ...cm } = toCmCompletion(item);
  return Object.assign(cm, {
    lsp: item,
    req,
    // CodeMirror merges options with the same label, detail and `apply`: overloads
    // sharing a filterText (`times(other: Int)`, `times(other: Long)`…) and the same
    // name imported from different modules need their own.
    apply:
      cm.displayLabel || (item.filterText && item.filterText !== item.label) || item.additionalEdits.length
        ? (...a: Parameters<typeof applyLsp>) => applyLsp(...a)
        : applyLsp,
    info: (c: Completion) => renderInfo(c as LspCompletion),
  });
}

/**
 * Sources other features contribute via the `openideaCompletion` language-data
 * key (live templates, postfix, SQL). Results starting where the first one
 * does are merged into one list. Options may carry `icon` (an icon name, `null`
 * for none) and `typeText` (the right-aligned type column), like LSP items.
 */
const contributedSource: CompletionSource = async (ctx) => {
  const results: CompletionResult[] = [];
  for (const source of ctx.state.languageDataAt<CompletionSource>("openideaCompletion", ctx.pos)) {
    const result = await source(ctx);
    if (result) results.push(result);
  }
  return mergeResults(results);
};

export function mergeResults(results: readonly CompletionResult[]): CompletionResult | null {
  const [first] = results;
  if (!first || results.length === 1) return first ?? null;
  const same = results.filter((r) => r.from === first.from);
  const validFor = same.every(
    (r) => r.validFor instanceof RegExp && r.validFor.source === (first.validFor as RegExp | undefined)?.source,
  )
    ? first.validFor
    : undefined;
  return { from: first.from, to: first.to, options: same.flatMap((r) => r.options), validFor };
}

/** Rendering extras of contributed (non-LSP) options. */
interface RichCompletion extends Completion {
  icon?: string | null;
  typeText?: string;
}

/** Documents the server could not complete in, so typing doesn't ask again until a server is ready. */
const completionBackoff = featureBackoff();

async function lspCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  const doc = ctx.state.facet(lspDoc);
  if (!doc || doc.readOnly) return null;
  const word = ctx.matchBefore(WORD_BEFORE);
  const trigger = triggerCharacter(ctx.state.sliceDoc(Math.max(0, ctx.pos - 2), ctx.pos));
  if (!ctx.explicit && !word && !trigger) return null;
  if (!ctx.explicit && word && !trigger && /^\d/.test(word.text)) return null;
  if (completionBackoff.active(doc.doc)) return fallback(ctx);
  cancelInflight();
  const id = nextRequestId();
  inflight = id;
  ctx.addEventListener("abort", () => {
    if (inflight === id) cancelInflight();
  });
  let list;
  try {
    list = await lspRequest(
      () => commands.lspCompletion(id, doc.doc, offsetToPos(ctx.state.doc, ctx.pos), trigger),
      () => inflight === id,
    );
  } catch (e) {
    if (isUnavailable(e)) {
      completionBackoff.mark(doc.doc);
      return fallback(ctx);
    }
    return null;
  } finally {
    if (inflight === id) inflight = null;
  }
  if (ctx.aborted || !list.items.length) return list.items.length ? null : fallback(ctx);
  const req: RequestContext = { doc: doc.doc, path: doc.path, language: doc.uiMode, pos: ctx.pos, text: ctx.state.doc };
  const prefs = editorPrefs().completion;
  const typed = word?.text ?? "";
  let items = withoutDuplicates(
    prefs.matchCase
      ? list.items.filter((it) => matchesCase(it.filterText ?? it.label, typed, prefs.caseSensitivity))
      : list.items,
  );
  // A server snippet named like a live template (jdtls `sout`, `fori`) would be listed twice; the template wins.
  if (items.some((it) => it.kind === "snippet")) {
    const own = await contributedSource(ctx);
    if (ctx.aborted) return null;
    const names = new Set(own?.options.map((o) => o.label));
    if (names.size) items = items.filter((it) => it.kind !== "snippet" || !names.has(it.label));
  }
  return {
    from: word ? word.from : ctx.pos,
    options: items.map((item) => makeCompletion(item, req)),
    // "All letters" must re-check case on every keystroke.
    validFor: list.isIncomplete || (prefs.matchCase && prefs.caseSensitivity === "all") ? undefined : VALID_FOR,
    filter: true,
  };
}

/**
 * Code Completion › Sort suggestions alphabetically: the source's options are
 * filtered here (prefix, substring, then subsequence) and listed by name;
 * typing on re-filters the same options while the source's `validFor` holds.
 */
export function sortAlphabetically(result: CompletionResult, typed: string): CompletionResult {
  if (result.filter === false) return result;
  const matched = new Map<Completion, readonly number[]>();
  for (const o of result.options) {
    const m = matchRanges(o.label, typed);
    if (m) matched.set(o, o.displayLabel ? [] : m);
  }
  const name = (c: Completion) => c.displayLabel ?? c.label;
  const options = [...matched.keys()].sort(
    (a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" }) || name(a).localeCompare(name(b)),
  );
  const { validFor } = result;
  return {
    from: result.from,
    to: result.to,
    options,
    filter: false,
    getMatch: (c) => matched.get(c) ?? [],
    update: validFor
      ? (_cur, from, to, ctx) => {
          const text = ctx.state.sliceDoc(from, to);
          const ok =
            typeof validFor === "function"
              ? validFor(text, from, to, ctx.state)
              : new RegExp(`^(?:${validFor.source})$`, validFor.flags).test(text);
          return ok ? sortAlphabetically({ ...result, from }, text) : null;
        }
      : undefined,
  };
}

/** Matched ranges of `typed` in `label`, ignoring case: a substring, else a subsequence; null without a match. */
export function matchRanges(label: string, typed: string): number[] | null {
  if (!typed) return [];
  const lower = label.toLowerCase();
  const p = typed.toLowerCase();
  const at = lower.indexOf(p);
  if (at >= 0) return [at, at + p.length];
  const ranges: number[] = [];
  let i = 0;
  for (let j = 0; j < lower.length && i < p.length; j++) {
    if (lower[j] !== p[i]) continue;
    if (ranges.length && ranges[ranges.length - 1] === j) ranges[ranges.length - 1] = j + 1;
    else ranges.push(j, j + 1);
    i++;
  }
  return i === p.length ? ranges : null;
}

/** Code Completion › Match case: first letter only, or every typed letter (as a subsequence). */
export function matchesCase(label: string, typed: string, mode: string): boolean {
  if (!typed) return true;
  if (mode !== "all") {
    const first = typed[0]!;
    const head = label[0] ?? "";
    return head.toLowerCase() !== first.toLowerCase() || head === first;
  }
  let i = 0;
  for (const ch of label) if (ch === typed[i]) i++;
  return i >= typed.length;
}

/**
 * A source another feature restricts the lookup to, via the
 * `openideaExclusiveCompletion` language-data key (`(state) => source | null`;
 * ⌘J's live templates).
 */
function exclusiveSource(ctx: CompletionContext): CompletionSource | null {
  type Provider = (state: CompletionContext["state"]) => CompletionSource | null;
  for (const f of ctx.state.languageDataAt<Provider>("openideaExclusiveCompletion", ctx.pos)) {
    const source = f(ctx.state);
    if (source) return source;
  }
  return null;
}

/** Show suggestions as you type: sources only answer explicit requests when it is off. */
function gated(source: CompletionSource): CompletionSource {
  return (ctx) => {
    const only = exclusiveSource(ctx);
    if (only) return source === contributedSource ? only(ctx) : null;
    if (!ctx.explicit && (!editorPrefs().completion.autoPopup || inplaceRenameActive(ctx.state))) return null;
    if (!editorPrefs().completion.sortAlphabetically) return source(ctx);
    return Promise.resolve(source(ctx)).then(
      (r) => r && sortAlphabetically(r, ctx.state.sliceDoc(r.from, r.to ?? ctx.pos)),
    );
  };
}

// ---------------------------------------------------------------------------
// Lookup focus, commit characters, explicit invocation

/**
 * As in IDEA, these finish a *focused* lookup with the selected
 * item before being typed; an unfocused auto-popup just
 * closes on them unless Settings › Code Completion › "Insert selected
 * suggestion by pressing space, dot…" is on.
 */
export const COMMIT_CHARS = [".", ",", ";", "=", " ", ":", "("];

/** Lookups the user engaged with: opened explicitly (⌃Space) or navigated with ↑/↓. */
const focusedLookups = new WeakSet<EditorView>();
/** Explicit invocations waiting for their first result (single candidate → insert it). */
const explicitPending = new WeakSet<EditorView>();

const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown"]);

/** Whether typing `ch` finishes the open lookup with its selected item. */
export function commitsLookup(
  ch: string,
  focused: boolean,
  insertOnSpecialKeys: boolean,
  itemChars: readonly string[] = [],
): boolean {
  if (!focused && !insertOnSpecialKeys) return false;
  return COMMIT_CHARS.includes(ch) || itemChars.includes(ch);
}

const lookupKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.isComposing || completionStatus(view.state) !== "active") return false;
      if (NAVIGATION_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        focusedLookups.add(view);
        return false;
      }
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return false;
      const selected = selectedCompletion(view.state);
      if (!selected) return false;
      const itemChars = isLsp(selected) ? selected.lsp.commitCharacters : (selected.commitCharacters ?? []);
      if (!commitsLookup(e.key, focusedLookups.has(view), editorPrefs().completion.insertOnSpecialKeys, itemChars))
        return false;
      if (!acceptCompletion(view)) return false;
      // A call snippet or inserted parentheses already opened the call: the typed one is consumed.
      const head = view.state.selection.main.head;
      if (
        e.key === "(" &&
        (view.state.sliceDoc(head - 1, head) === "(" || view.state.sliceDoc(head - 2, head) === "()")
      ) {
        e.preventDefault();
        return true;
      }
      return false;
    },
  }),
);

/** IDEA inserts a sole candidate right away on explicit invocation (Code Completion › Automatically insert single suggestions). */
const AUTO_INSERT_DELAY = 80; // past CodeMirror's interactionDelay

const lookupTracker = ViewPlugin.fromClass(
  class {
    private prev: ReturnType<typeof completionStatus> = null;
    constructor(private view: EditorView) {}
    update(u: ViewUpdate) {
      const status = completionStatus(u.state);
      const prev = this.prev;
      this.prev = status;
      if (status === prev && status !== "active") return;
      const view = this.view;
      if (status === null) {
        focusedLookups.delete(view);
        resetLookupDocs();
        if (explicitPending.has(view)) {
          explicitPending.delete(view);
          if (prev === "pending" && !u.docChanged)
            queueMicrotask(() => showHint(view, "No suggestions", { timeout: 2000 }));
        }
      } else if (status === "active" && explicitPending.has(view)) {
        explicitPending.delete(view);
        const options = currentCompletions(u.state);
        if (options.length === 1 && editorPrefs().completion.autoInsertSingle) {
          const doc = u.state.doc;
          setTimeout(() => {
            const now = currentCompletions(view.state);
            if (
              view.state.doc === doc &&
              completionStatus(view.state) === "active" &&
              now.length === 1 &&
              now[0] === options[0]
            )
              acceptCompletion(view);
          }, AUTO_INSERT_DELAY);
        }
      }
    }
  },
);

/** ⌃Space: explicit completion (a focused lookup; a sole candidate is inserted at once). */
export function explicitCompletion(view: EditorView): boolean {
  explicitPending.add(view);
  const started = startCompletion(view);
  if (!started) explicitPending.delete(view);
  else focusedLookups.add(view);
  return started;
}

// ---------------------------------------------------------------------------
// Rendering

function kindBadge(c: Completion): Node | null {
  if (!isLsp(c) && "icon" in c) {
    const icon = (c as RichCompletion).icon;
    if (icon) return iconNode(icon, 16, "cm-lsp-kind");
    const blank = document.createElement("span");
    blank.className = "cm-lsp-kind";
    return blank;
  }
  const kind = isLsp(c) ? completionSymbolKind(c.lsp.kind) : (c.type ?? "text");
  const span = iconNode(`symbol-${kind}`, 16, "cm-lsp-kind");
  span.dataset.kind = kind;
  return span;
}

function typeColumn(c: Completion): Node | null {
  const detail = isLsp(c) ? typeColumnText(c.lsp) : (c as RichCompletion).typeText?.replace(/\s+/g, " ");
  if (!detail) return null;
  const span = document.createElement("span");
  span.className = "cm-lsp-type";
  span.textContent = detail;
  return span;
}

/** Toggles Code Completion › Sort suggestions alphabetically (globally) and re-opens the lookup. */
async function toggleSortByName(view: EditorView) {
  const on = !editorPrefs().completion.sortAlphabetically;
  if (isTauri()) {
    const settings = await call(
      commands.settingsSet("global", "editor.completion.sortAlphabetically", JSON.stringify(on)),
    );
    useProject.setState({ settings });
  }
  if (!view.dom.isConnected) return;
  closeCompletion(view);
  startCompletion(view);
}

function sortToggle(view: EditorView): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-lsp-completion-sort";
  button.textContent = tx("Sort by name");
  const on = editorPrefs().completion.sortAlphabetically;
  button.setAttribute("aria-pressed", String(on));
  button.title = tx(on ? "Sort suggestions by relevance" : "Sort suggestions alphabetically");
  // Keep the editor focused so the lookup survives the click.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => void toggleSortByName(view).catch(() => {}));
  return button;
}

/** IDEA's advertiser bar under the list (one tip: "Press ↵ to insert, ⇥ to replace") and its Sort by Name toggle. */
const completionFooter = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {}
    update(u: ViewUpdate) {
      if (completionStatus(u.state) !== "active") return;
      this.view.requestMeasure({
        read: () => null,
        write: () => {
          const scope = this.view.dom.ownerDocument;
          const tooltips = [
            ...this.view.dom.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete"),
            ...scope.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete"),
          ];
          for (const t of tooltips) {
            if (t.querySelector(":scope > .cm-lsp-completion-footer")) continue;
            const footer = document.createElement("div");
            footer.className = "cm-lsp-completion-footer";
            const tip = document.createElement("span");
            tip.textContent = tx("Press ↵ to insert, ⇥ to replace");
            footer.append(tip, sortToggle(this.view));
            t.appendChild(footer);
          }
        },
      });
    }
  },
);

export function completionExtension() {
  return [
    lookupKeys,
    prefetchResolve,
    autocompletion({
      override: [gated(lspCompletionSource), gated(contributedSource), gated(pathCompletionSource)],
      icons: false,
      addToOptions: [
        { render: kindBadge, position: 20 },
        { render: typeColumn, position: 90 },
      ],
      optionClass: (c) => {
        // IDEA shows keywords in bold.
        const keyword = (isLsp(c) ? c.lsp.kind : c.type) === "keyword" ? " cm-lsp-keyword-option" : "";
        return (
          (isLsp(c) ? (c.lsp.deprecated ? "cm-lsp-option cm-lsp-deprecated-option" : "cm-lsp-option") : "") + keyword
        );
      },
      tooltipClass: () => "cm-lsp-completion",
    }),
    completionFooter,
    lookupTracker,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            if (completionStatus(view.state) !== "active") return false;
            replaceMode = true;
            try {
              return acceptCompletion(view);
            } finally {
              replaceMode = false;
            }
          },
        },
      ]),
    ),
  ];
}

export { startCompletion };
