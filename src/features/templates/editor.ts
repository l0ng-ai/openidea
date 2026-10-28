/**
 * Editor side of live templates and postfix completion: Tab expansion,
 * ⌘J template lookup, Surround With chooser, completion source and snippet
 * application / field navigation.
 */
import {
  clearSnippet,
  closeCompletion,
  completionStatus,
  nextSnippetField,
  prevSnippetField,
  snippet,
  snippetKeymap,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { whenSynced, type EditorDocContext } from "@/editor/api";
import { structure, type StructuralRanges } from "@/editor/structure";
import { offsetToPos, posToOffset } from "@/editor/lsp/positions";
import { calledFunctions, expandTemplate, applicableTemplates, usesSelection, type LiveTemplate } from "./live/model";
import { surroundEntries, surroundersFor, type Surrounder } from "./live/surrounders";
import { liveTemplates, useLiveTemplateOptions } from "./live/store";
import { inCommentOrString, templateFunctions } from "./editorContext";
import {
  candidatesFor,
  findPostfixTarget,
  isCompound,
  postfixTemplatesFor,
  type PostfixTarget,
  type PostfixTemplate,
} from "./postfix/model";
import { usePostfixSettings } from "./postfix/store";
import { showChooser, type ChooserItem } from "./popup/store";
import { expandEmmetAtCaret } from "./emmet/editor";

export interface TemplateDocInfo {
  path: string;
  language: string;
}

/** Document path / language for template contexts. */
export const templateDoc = Facet.define<TemplateDocInfo, TemplateDocInfo>({
  combine: (v) => v[v.length - 1] ?? { path: "", language: "plaintext" },
});

/**
 * Language-data key under which the template completion source is published.
 * The LSP completion uses `override`, so it must merge sources found under
 * this key (`state.languageDataAt<CompletionSource>(EXTRA_COMPLETION_KEY, pos)`).
 */
export const EXTRA_COMPLETION_KEY = "openideaCompletion";

/**
 * Language-data key for a lookup restricted to one source: `(state) =>
 * CompletionSource | null`. While one returns a source, the LSP completion
 * queries only that source (⌘J lists live templates only).
 */
export const EXCLUSIVE_COMPLETION_KEY = "openideaExclusiveCompletion";

function userName(): string {
  const root = useProject.getState().project?.root ?? "";
  return /^\/(?:Users|home)\/([^/]+)/.exec(root)?.[1] ?? /^[A-Za-z]:\\Users\\([^\\]+)/.exec(root)?.[1] ?? "";
}

async function readClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

function needsClipboard(t: Pick<LiveTemplate, "variables">): boolean {
  return (t.variables ?? []).some((v) =>
    [v.expression, v.defaultValue].some((e) => e && calledFunctions(e).includes("clipboard")),
  );
}

export interface ExpandOptions {
  /** Text for `$SELECTION$` and the indentation of its first line. */
  selection?: string;
  selectionIndent?: string;
  predefined?: Record<string, string>;
  expression?: string;
}

/** Replaces `from..to` with the expanded template and activates its tab stops. */
export async function expandInto(
  view: EditorView,
  t: Pick<LiveTemplate, "body" | "variables">,
  from: number,
  to: number,
  opts: ExpandOptions = {},
): Promise<void> {
  const doc = view.state.facet(templateDoc);
  const clipboard = needsClipboard(t) ? await readClipboard() : "";
  const state = view.state;
  const fns = templateFunctions({
    state,
    pos: from,
    path: doc.path,
    language: doc.language,
    clipboard,
    user: userName(),
    expression: opts.expression,
  });
  const exp = expandTemplate(t, {
    fns,
    selection: opts.selection,
    selectionIndent: opts.selectionIndent,
    predefined: opts.predefined,
  });
  // The document may have changed while reading the clipboard.
  if (view.state.doc !== state.doc) return;
  snippet(exp.snippet)(view, null, from, to);
  if (view.state.field(fieldCompletion, false) !== undefined)
    view.dispatch({ effects: setFieldCompletion.of(exp.completing) });
  if (exp.completeFirst) setTimeout(() => startCompletion(view), 0);
}

/** Per field of the last expanded template: whether it asks for completion (`complete()`, `dbObjectName()`…). */
const setFieldCompletion = StateEffect.define<readonly boolean[]>();
const fieldCompletion = StateField.define<readonly boolean[]>({
  create: () => [],
  update: (value, tr) => tr.effects.find((e) => e.is(setFieldCompletion))?.value ?? value,
});

/**
 * The snippet field a transaction moves to. CodeMirror doesn't expose it; its
 * snippet-state effect carries the active snippet (`{ ranges, active }`).
 */
function movedToField(tr: Transaction): number | null {
  for (const e of tr.effects) {
    const v = e.value as { active?: unknown; ranges?: unknown } | null;
    if (v && typeof v === "object" && typeof v.active === "number" && Array.isArray(v.ranges)) return v.active;
  }
  return null;
}

/** Moving to a field that asks for completion opens it, as IDEA does. */
const completeOnFieldMove = EditorView.updateListener.of((u) => {
  if (u.docChanged) return;
  const flags = u.state.field(fieldCompletion);
  const field = u.transactions.map(movedToField).findLast((i) => i !== null);
  if (field == null || !flags[field]) return;
  setTimeout(() => {
    if (u.view.state.selection === u.state.selection) startCompletion(u.view);
  }, 0);
});

/**
 * Esc in a template, as in IDEA: first drops the selection (closing the lookup)
 * or closes the lookup; only with neither does it leave the template.
 */
export const escapeTemplate: Command = (view) => {
  const sel = view.state.selection;
  if (sel.ranges.some((r) => !r.empty)) {
    closeCompletion(view);
    view.dispatch({
      selection: EditorSelection.create(
        sel.ranges.map((r) => EditorSelection.cursor(r.head)),
        sel.mainIndex,
      ),
    });
    return true;
  }
  if (completionStatus(view.state) === "active") return closeCompletion(view);
  return clearSnippet(view);
};

const unlessLookup =
  (cmd: Command): Command =>
  (view) =>
    completionStatus(view.state) === "active" ? false : cmd(view);

/** Tab and Enter both move to the next field (Enter is the lookup's while it is open). */
const templateFieldKeys = snippetKeymap.of([
  { key: "Tab", run: unlessLookup(nextSnippetField), shift: prevSnippetField },
  { key: "Enter", run: unlessLookup(nextSnippetField) },
  { key: "Escape", run: escapeTemplate },
]);

// ---------------------------------------------------------------------------
// Live templates

const ABBREV_BEFORE = /[\w$!#@.-]+$/;

/** The abbreviation candidate before the caret (stops at `.` so `x.if` isn't one). */
export function wordBefore(state: EditorState, pos: number): { from: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const m = ABBREV_BEFORE.exec(state.sliceDoc(line.from, pos));
  if (!m) return null;
  let text = m[0];
  const dot = text.lastIndexOf(".");
  if (dot >= 0) text = text.slice(dot + 1);
  if (!text) return null;
  return { from: pos - text.length, text };
}

/**
 * Language-data key under which features report finer template contexts at a
 * position: `(state, pos) => readonly string[]` (e.g. SQL `sql-statement`).
 */
export const TEMPLATE_CONTEXT_KEY = "openideaTemplateContexts";

type ContextProvider = (state: EditorState, pos: number) => readonly string[];

export function templatesAt(state: EditorState, pos: number): LiveTemplate[] {
  const { language } = state.facet(templateDoc);
  const contexts = state.languageDataAt<ContextProvider>(TEMPLATE_CONTEXT_KEY, pos).flatMap((f) => f(state, pos));
  return applicableTemplates(liveTemplates(), language, { inCommentOrString: inCommentOrString(state, pos), contexts });
}

/** Templates whose abbreviation equals the word before the caret. */
function exactMatches(state: EditorState): { word: { from: number; text: string }; list: LiveTemplate[] } | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const word = wordBefore(state, sel.head);
  if (!word) return null;
  // `x.if` is a postfix key, not an abbreviation.
  if (state.sliceDoc(word.from - 1, word.from) === ".") return null;
  const list = templatesAt(state, sel.head).filter((t) => t.abbrev === word.text && !usesSelection(t.body));
  return list.length ? { word, list } : null;
}

export function caretAnchor(view: EditorView): { x: number; y: number } {
  let c: { left: number; bottom: number } | null = null;
  try {
    c = view.coordsAtPos(view.state.selection.main.head);
  } catch {
    // no layout (tests)
  }
  if (c) return { x: c.left, y: c.bottom };
  const r = view.dom.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + 40 };
}

function chooseTemplate(
  view: EditorView,
  title: string,
  list: LiveTemplate[],
  filter: string,
  onPick: (t: LiveTemplate) => void,
) {
  showChooser({
    title,
    anchor: caretAnchor(view),
    filter,
    filterable: true,
    emptyText: "No matching templates",
    items: list.map((t) => ({ key: t.id, label: t.abbrev, detail: t.description, search: t.description })),
    onPick: (item) => {
      const t = list.find((x) => x.id === item.key);
      view.focus();
      if (t) onPick(t);
    },
    onCancel: () => view.focus(),
  });
}

export function expandLiveTemplateAtCaret(view: EditorView): boolean {
  const found = exactMatches(view.state);
  if (!found) return false;
  const { word, list } = found;
  const head = view.state.selection.main.head;
  if (list.length === 1) void expandInto(view, list[0]!, word.from, head);
  else
    chooseTemplate(
      view,
      "Choose Template",
      list,
      "",
      (t) => void expandInto(view, t, word.from, view.state.selection.main.head),
    );
  return true;
}

/** Whether the open (or opening) lookup is ⌘J's template-only one. */
const setTemplateLookup = StateEffect.define<boolean>();
const templateLookup = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setTemplateLookup) ? e.value : v), value),
});

const endTemplateLookup = EditorView.updateListener.of((u) => {
  if (!u.state.field(templateLookup) || completionStatus(u.startState) === null || completionStatus(u.state) !== null)
    return;
  queueMicrotask(() => {
    if (u.view.state.field(templateLookup) && completionStatus(u.view.state) === null)
      u.view.dispatch({ effects: setTemplateLookup.of(false) });
  });
});

/** Live templates applicable at `pos` as lookup items replacing the word before it. */
function liveTemplateOptions(
  state: EditorState,
  pos: number,
  word: { from: number; text: string } | null,
): CompletionResult | null {
  const list = templatesAt(state, pos).filter((t) => !usesSelection(t.body));
  if (!list.length) return null;
  return {
    from: word?.from ?? pos,
    // IDEA: the description right-aligned, an exact abbreviation first.
    options: list.map((t) => ({
      label: t.abbrev,
      typeText: t.description,
      type: "snippet",
      boost: word && t.abbrev === word.text ? 5 : -5,
      apply: (view: EditorView, _c: Completion, from: number, to: number) => void expandInto(view, t, from, to),
    })),
    validFor: /^[\w$!#@-]*$/,
  };
}

const templateLookupSource: CompletionSource = ({ state, pos }) => {
  const word = wordBefore(state, pos);
  const prefix = word && state.sliceDoc(word.from - 1, word.from) !== "." ? word : null;
  return liveTemplateOptions(state, pos, prefix);
};

/**
 * ⌘J: a completion lookup of the templates applicable here, filtered by the
 * word before the caret; typing keeps filtering it.
 */
export function insertLiveTemplate(view: EditorView) {
  closeCompletion(view);
  view.dispatch({ effects: setTemplateLookup.of(true) });
  if (!startCompletion(view)) view.dispatch({ effects: setTemplateLookup.of(false) });
}

/**
 * The whole lines of the statement (or member) at a caret on `line` when it
 * spans several lines, from the tree-sitter structure service; `null` when the
 * statement is a single line, broken, or shares its lines with other code.
 */
export function multiLineStatement(
  state: EditorState,
  r: StructuralRanges | null,
): { from: number; to: number } | null {
  if (!r) return null;
  const span = (n: NonNullable<StructuralRanges["statement"]>) => ({
    from: posToOffset(state.doc, n.range.start),
    to: posToOffset(state.doc, n.range.end),
  });
  const stmt = r.statement && span(r.statement);
  const decl = r.declaration && span(r.declaration);
  const useStatement = !!stmt && (!decl || (decl.from <= stmt.from && stmt.to <= decl.to));
  const node = useStatement ? r.statement : r.declaration;
  const s = useStatement ? stmt : decl;
  if (!node || !s || node.hasError) return null;
  const first = state.doc.lineAt(s.from);
  const last = state.doc.lineAt(s.to);
  if (first.number === last.number) return null;
  if (state.sliceDoc(first.from, s.from).trim() || !/^\s*;?\s*$/.test(state.sliceDoc(s.to, last.to))) return null;
  return { from: first.from, to: last.to };
}

/** The statement range Surround With uses for a caret (no selection), if the structure service knows it. */
export async function surroundTarget(
  view: EditorView,
  ctx: EditorDocContext,
): Promise<{ from: number; to: number } | null> {
  const state = view.state;
  if (!state.selection.main.empty || state.selection.ranges.length > 1) return null;
  try {
    if (!(await structure.support(ctx.language)).tree) return null;
    await whenSynced(view);
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const r = await structure.structuralRanges(ctx.doc, offsetToPos(view.state.doc, line.from));
    return view.state.doc === state.doc ? multiLineStatement(view.state, r) : null;
  } catch {
    return null;
  }
}

export const CONFIGURE_TEMPLATES_KEY = "\u0000configure";

/**
 * ⌥⌘T: wraps the selection (or, without one, `target` — the statement at the
 * caret — or the current line). As in IDEA the popup lists the language's
 * surrounders (mnemonics 1–9, 0, A–Z), then the `$SELECTION$` live templates
 * and "Configure Live Templates…".
 */
export function surroundWith(
  view: EditorView,
  target?: { from: number; to: number } | null,
  /** Surround with Live Template (⌥⌘J): only the `$SELECTION$` templates. */
  templatesOnly = false,
) {
  const state = view.state;
  const { language } = state.facet(templateDoc);
  const templates = applicableTemplates(liveTemplates(), language).filter((t) => usesSelection(t.body));
  let { from, to } = state.selection.main;
  const selected = from !== to;
  if (!selected && target && target.from <= from && from <= target.to) {
    ({ from, to } = target);
  } else if (!selected) {
    const line = state.doc.lineAt(from);
    from = line.from;
    to = line.to;
  }
  // Start at the first line's indentation, end before trailing blank lines.
  const first = state.doc.lineAt(from);
  const indent = /^[ \t]*/.exec(first.text)![0];
  if (from - first.from <= indent.length) from = first.from + indent.length;
  while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
  const selection = state.sliceDoc(from, to);
  const last = state.doc.lineAt(to);
  const lines = !selected || (from === first.from + indent.length && !state.sliceDoc(to, last.to).trim());
  const inline = selected && first.number === last.number && !!selection.trim();
  const surrounders = templatesOnly ? [] : surroundersFor(language, { lines, inline });
  const entries = surroundEntries(surrounders, templates);
  const byId = new Map<string, Surrounder | LiveTemplate>([...surrounders, ...templates].map((x) => [x.id, x]));
  const items: ChooserItem[] = [];
  for (const e of entries) {
    if (e.kind === "template" && !templatesOnly && !items.some((i) => i.section))
      items.push({ key: "\u0000templates", label: "Live templates", section: true });
    const x = byId.get(e.id)!;
    items.push(
      e.kind === "surrounder"
        ? { key: e.id, label: x.description, mnemonic: e.mnemonic ?? undefined }
        : {
            key: e.id,
            label: (x as LiveTemplate).abbrev,
            detail: x.description,
            mnemonic: e.mnemonic ?? undefined,
            mnemonicIndex: e.mnemonicIndex ?? undefined,
          },
    );
  }
  if (templates.length) {
    items.push({ key: "\u0000separator", label: "", section: true });
    items.push({ key: CONFIGURE_TEMPLATES_KEY, label: "Configure Live Templates…" });
  }
  showChooser({
    title: templatesOnly ? "Surround with Live Template" : "Surround With",
    anchor: caretAnchor(view),
    mnemonics: true,
    emptyText: templatesOnly ? "No live templates to surround with" : "Nothing to surround with here",
    items,
    onPick: (item) => {
      view.focus();
      if (item.key === CONFIGURE_TEMPLATES_KEY) {
        void executeAction("file.settings", "editor.liveTemplates");
        return;
      }
      const t = byId.get(item.key);
      if (!t || view.state.sliceDoc(from, to) !== selection) return;
      view.dispatch({ selection: EditorSelection.range(from, to) });
      void expandInto(view, t, from, to, { selection, selectionIndent: indent });
    },
    onCancel: () => view.focus(),
  });
}

// ---------------------------------------------------------------------------
// Postfix

export function applyPostfix(view: EditorView, t: PostfixTemplate, target: PostfixTarget) {
  const candidates = candidatesFor(t, target);
  const run = (c: PostfixTarget["candidates"][number]) => {
    const expr = t.wrapCompound && isCompound(c.text) ? `(${c.text})` : c.text;
    // The key may have grown since the target was computed (completion).
    const end = Math.max(target.end, view.state.selection.main.head);
    void expandInto(view, t, c.from, end, { predefined: { EXPR: expr }, expression: c.text });
  };
  if (candidates.length <= 1) {
    if (candidates[0]) run(candidates[0]);
    return;
  }
  showChooser({
    title: "Expressions",
    anchor: caretAnchor(view),
    items: candidates.map((c, i) => ({ key: String(i), label: c.text.replace(/\s+/g, " ") })),
    onPick: (item) => {
      view.focus();
      run(candidates[Number(item.key)]!);
    },
    onCancel: () => view.focus(),
  });
}

function postfixAt(state: EditorState, pos: number): { target: PostfixTarget; templates: PostfixTemplate[] } | null {
  const settings = usePostfixSettings.getState();
  if (!settings.enabled) return null;
  const { language } = state.facet(templateDoc);
  const templates = postfixTemplatesFor(language, new Set(settings.disabled));
  if (!templates.length || inCommentOrString(state, pos)) return null;
  const target = findPostfixTarget(state, pos, language);
  if (!target) return null;
  return { target, templates: templates.filter((t) => candidatesFor(t, target).length > 0) };
}

export function expandPostfixAtCaret(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty || !usePostfixSettings.getState().expandWithTab) return false;
  const found = postfixAt(view.state, sel.head);
  if (!found || !found.target.key) return false;
  const t = found.templates.find((x) => x.key === found.target.key);
  if (!t) return false;
  applyPostfix(view, t, found.target);
  return true;
}

// ---------------------------------------------------------------------------
// Completion

export const templateCompletionSource: CompletionSource = (ctx: CompletionContext): CompletionResult | null => {
  const { state, pos } = ctx;
  if (state.field(templateLookup, false)) return templateLookupSource(ctx) as CompletionResult | null;
  const word = wordBefore(state, pos);
  const afterDot = word ? state.sliceDoc(word.from - 1, word.from) === "." : state.sliceDoc(pos - 1, pos) === ".";
  if (afterDot) {
    if (!usePostfixSettings.getState().showInCompletion) return null;
    const found = postfixAt(state, pos);
    if (!found || !found.templates.length) return null;
    const { target } = found;
    const options: Completion[] = found.templates.map((t) => ({
      label: t.key,
      detail: t.description,
      type: "snippet",
      boost: -10,
      section: { name: "Postfix", rank: 99 },
      apply: (view: EditorView) => {
        const now = findPostfixTarget(
          view.state,
          view.state.selection.main.head,
          view.state.facet(templateDoc).language,
        );
        applyPostfix(view, t, now ? { ...now, end: view.state.selection.main.head } : target);
      },
    }));
    return { from: target.dot + 1, options, validFor: /^\w*$/ };
  }
  if (!word || !useLiveTemplateOptions.getState().showInCompletion) return null;
  return liveTemplateOptions(state, pos, word);
};

// ---------------------------------------------------------------------------
// Extension

export function templateEditorExtension(ctx: EditorDocContext): Extension {
  return [
    templateDoc.of({ path: ctx.path, language: ctx.language }),
    fieldCompletion,
    completeOnFieldMove,
    templateFieldKeys,
    templateLookup,
    endTemplateLookup,
    EditorState.languageData.of(() => [
      {
        [EXTRA_COMPLETION_KEY]: templateCompletionSource,
        [EXCLUSIVE_COMPLETION_KEY]: (state: EditorState) =>
          state.field(templateLookup, false) ? templateLookupSource : null,
      },
    ]),
    Prec.high(
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            if (view.state.readOnly || completionStatus(view.state) === "active") return false;
            if (expandPostfixAtCaret(view)) return true;
            if (useLiveTemplateOptions.getState().expandWithTab && expandLiveTemplateAtCaret(view)) return true;
            return expandEmmetAtCaret(view, ctx.language);
          },
        },
      ]),
    ),
  ];
}
