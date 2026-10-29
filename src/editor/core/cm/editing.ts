/**
 * IDEA editing commands on top of @codemirror/commands.
 */
import {
  EditorSelection,
  StateEffect,
  StateField,
  countColumn,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import {
  foldedRanges,
  forceParsing,
  syntaxTree,
  getIndentUnit,
  indentString,
  getIndentation,
} from "@codemirror/language";
import {
  copyLineDown,
  deleteLine as deleteDocLine,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
} from "@codemirror/commands";
import { SearchCursor } from "@codemirror/search";
import { humpLeft, humpRight, wordStartLeft } from "../model/camelHumps";

type Node = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

// --- CamelHumps -------------------------------------------------------------

function humpTarget(state: EditorState, pos: number, forward: boolean, camel = true): number {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  if (forward) {
    if (col >= line.length) return Math.min(state.doc.length, line.to + 1);
    return line.from + humpRight(line.text, col);
  }
  if (col <= 0) return Math.max(0, line.from - 1);
  return line.from + (camel ? humpLeft(line.text, col) : wordStartLeft(line.text, col));
}

function moveHump(forward: boolean, extend: boolean): Command {
  return (view) => {
    const sel = EditorSelection.create(
      view.state.selection.ranges.map((r) => {
        if (!extend && !r.empty) return EditorSelection.cursor(forward ? r.to : r.from);
        const head = humpTarget(view.state, r.head, forward);
        return extend ? EditorSelection.range(r.anchor, head) : EditorSelection.cursor(head);
      }),
      view.state.selection.mainIndex,
    );
    view.dispatch({ selection: sel, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

export const cursorHumpLeft = moveHump(false, false);
export const cursorHumpRight = moveHump(true, false);
export const selectHumpLeft = moveHump(false, true);
export const selectHumpRight = moveHump(true, true);

function deleteHump(forward: boolean, camel = true): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const tr = view.state.changeByRange((r) => {
      if (!r.empty) return { changes: { from: r.from, to: r.to }, range: EditorSelection.cursor(r.from) };
      const target = humpTarget(view.state, r.head, forward, camel);
      const from = Math.min(target, r.head);
      const to = Math.max(target, r.head);
      return { changes: { from, to }, range: EditorSelection.cursor(from) };
    });
    view.dispatch(
      view.state.update(tr, { scrollIntoView: true, userEvent: forward ? "delete.forward" : "delete.backward" }),
    );
    return true;
  };
}

export const deleteHumpBackward = deleteHump(false);
export const deleteHumpForward = deleteHump(true);
/** ⌥⌫ / Ctrl+Backspace without CamelHumps: the whitespace before the caret and the word (or punctuation run) before it. */
export const deleteWordBackward = deleteHump(false, false);

// --- lines / selections -------------------------------------------------------

/**
 * The whole lines `[from, to]` touches, grown to the visual lines they are
 * part of: a folded region's lines go together with the line it is shown on.
 */
export function visualLineSpan(state: EditorState, from: number, to: number): { from: number; to: number } {
  let a = state.doc.lineAt(from).from;
  let b = state.doc.lineAt(to).to;
  const folded = foldedRanges(state);
  for (let changed = true; changed;) {
    changed = false;
    folded.between(a, b, (f, t) => {
      const na = Math.min(a, state.doc.lineAt(f).from);
      const nb = Math.max(b, state.doc.lineAt(t).to);
      if (na !== a || nb !== b) {
        a = na;
        b = nb;
        changed = true;
      }
    });
  }
  return { from: a, to: b };
}

/** Visual line spans of the selection ranges, merged; `null` when no fold is involved. */
function foldedLineSpans(state: EditorState): Array<{ from: number; to: number }> | null {
  const spans: Array<{ from: number; to: number }> = [];
  let folds = false;
  for (const r of state.selection.ranges) {
    const end = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    const span = visualLineSpan(state, r.from, end);
    if (span.from !== state.doc.lineAt(r.from).from || span.to !== state.doc.lineAt(end).to) folds = true;
    const last = spans[spans.length - 1];
    if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to);
    else spans.push(span);
  }
  return folds ? spans : null;
}

/** ⌘D: duplicate the line (caret moves to the copy) or the selection (copy selected). */
export const duplicateLineOrSelection: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.every((r) => r.empty)) {
    const spans = foldedLineSpans(state);
    if (!spans) return copyLineDown(view);
    // On a folded region's line the whole folded block is duplicated.
    const changes = state.changes(
      spans.map((s) => ({ from: s.to, insert: state.lineBreak + state.sliceDoc(s.from, s.to) })),
    );
    const ranges = state.selection.ranges.map((r) => {
      const s = spans.find((sp) => sp.from <= r.head && r.head <= sp.to)!;
      return EditorSelection.cursor(changes.mapPos(r.head, -1) + s.to - s.from + state.lineBreak.length);
    });
    view.dispatch({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      scrollIntoView: true,
      userEvent: "input.duplicate",
    });
    return true;
  }
  const tr = state.changeByRange((r) => {
    if (r.empty) {
      const line = state.doc.lineAt(r.head);
      return {
        changes: { from: line.to, insert: state.lineBreak + line.text },
        range: EditorSelection.cursor(r.head + line.length + 1),
      };
    }
    const text = state.sliceDoc(r.from, r.to);
    return {
      changes: { from: r.to, insert: text },
      range: EditorSelection.range(r.to, r.to + text.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.duplicate" }));
  return true;
};

/** ⌘⌫: Delete Line — on a folded region's line, every line of the folded block. */
export const deleteLine: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const spans = foldedLineSpans(state);
  if (!spans) return deleteDocLine(view);
  const len = state.doc.length;
  const changes = state.changes(
    spans.map((s) => (s.to < len ? { from: s.from, to: s.to + 1 } : { from: Math.max(0, s.from - 1), to: s.to })),
  );
  const doc = changes.apply(state.doc);
  const ranges = state.selection.ranges.map((r) => {
    const col = r.head - state.doc.lineAt(r.head).from;
    const line = doc.lineAt(changes.mapPos(r.head, -1));
    return EditorSelection.cursor(line.from + Math.min(col, line.length));
  });
  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "delete.line",
  });
  return true;
};

// --- occurrences --------------------------------------------------------------

interface OccurrenceSearch {
  /** The sequence started from a bare caret: occurrences match whole words only. */
  wholeWords: boolean;
  /** The last search found nothing: the next one starts from the top. */
  notFound: boolean;
}

const setOccurrenceSearch = StateEffect.define<OccurrenceSearch>();

/** State of a run of Add Selection for Next Occurrence; any other selection change or edit ends it. */
export const occurrenceSearch = StateField.define<OccurrenceSearch | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setOccurrenceSearch)) return e.value;
    return tr.docChanged || tr.selection ? null : value;
  },
});

const IDENT = /[\p{L}\p{N}_$]/u;
const identAt = (state: EditorState, pos: number) =>
  pos >= 0 && pos < state.doc.length && IDENT.test(state.sliceDoc(pos, pos + 1));

/** The identifier at or right before `pos`. */
export function identifierAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let from = pos;
  let to = pos;
  while (from > 0 && identAt(state, from - 1)) from--;
  while (to < state.doc.length && identAt(state, to)) to++;
  return from < to ? { from, to } : null;
}

function isWholeWord(state: EditorState, from: number, to: number): boolean {
  if (identAt(state, from - 1) && identAt(state, from)) return false;
  return !(identAt(state, to) && identAt(state, to - 1));
}

/** Case-sensitive matches of `text` from `from` on (whole words only when asked). */
function* matches(state: EditorState, text: string, from: number, wholeWords: boolean) {
  const cursor = new SearchCursor(state.doc, text, from);
  for (cursor.next(); !cursor.done; cursor.next()) {
    const { from: a, to: b } = cursor.value;
    if (!wholeWords || isWholeWord(state, a, b)) yield { from: a, to: b };
  }
}

/** A selection of `m` with the head on the same side as in `like`. */
const rangeLike = (like: SelectionRange, m: { from: number; to: number }) =>
  like.head === like.from && like.from !== like.to
    ? EditorSelection.range(m.to, m.from)
    : EditorSelection.range(m.from, m.to);

/**
 * ⌃G: Add Selection for Next Occurrence. From a bare caret it selects the
 * word (and the run then matches whole words); with a selection it adds the
 * next match after the last added one. Nothing found reports `notFound` (the
 * caller hints); the next invocation then searches from the top.
 */
export function nextOccurrence(view: EditorView): "selected" | "added" | "notFound" | "none" {
  const { state } = view;
  const main = state.selection.main;
  if (main.empty) {
    const word = identifierAt(state, main.head);
    if (!word) return "none";
    view.dispatch({
      selection: state.selection.replaceRange(EditorSelection.range(word.from, word.to)),
      effects: setOccurrenceSearch.of({ wholeWords: true, notFound: false }),
      scrollIntoView: true,
      userEvent: "select",
    });
    return "selected";
  }
  const run = state.field(occurrenceSearch, false) ?? null;
  const wholeWords = !!run?.wholeWords;
  const text = state.sliceDoc(main.from, main.to);
  const hit = matches(state, text, run?.notFound ? 0 : main.to, wholeWords).next().value;
  if (!hit) {
    view.dispatch({ effects: setOccurrenceSearch.of({ wholeWords, notFound: true }) });
    return "notFound";
  }
  if (state.selection.ranges.some((r) => r.from === hit.from && r.to === hit.to)) {
    view.dispatch({ effects: setOccurrenceSearch.of({ wholeWords, notFound: !!run?.notFound }) });
    return "none";
  }
  view.dispatch({
    selection: state.selection.addRange(rangeLike(main, hit)),
    effects: [setOccurrenceSearch.of({ wholeWords, notFound: false }), EditorView.scrollIntoView(hit.from)],
    userEvent: "select",
  });
  return "added";
}

/** ⌃⌘G: select every occurrence of the selection, or of the word at the caret (whole words). */
export const selectAllOccurrences: Command = (view) => {
  const { state } = view;
  let main = state.selection.main;
  let wholeWords = false;
  if (main.empty) {
    const word = identifierAt(state, main.head);
    if (!word) return false;
    main = EditorSelection.range(word.from, word.to);
    wholeWords = true;
  }
  const text = state.sliceDoc(main.from, main.to);
  const ranges: SelectionRange[] = [];
  let mainIndex = 0;
  for (const m of matches(state, text, 0, wholeWords)) {
    if (m.from === main.from) mainIndex = ranges.length;
    ranges.push(rangeLike(main, m));
  }
  if (!ranges.length) return false;
  view.dispatch({ selection: EditorSelection.create(ranges, mainIndex), userEvent: "select" });
  return true;
};

// --- move statement -----------------------------------------------------------

interface LineSpan {
  from: number; // line start
  to: number; // line end (excl. break)
}

/** Nodes whose children are statements / members (plus the top node). */
const CONTAINER =
  /^(Program|Script|Module|SourceFile|Chunk|Document|StyleSheet|JsonText|Object|Array|BlockMapping|BlockSequence|Suite|CompoundStatement|DeclarationList|FieldDeclarationList|StatementList)$|Block$|Body$/;
/** Function / class-like nodes: Move Statement never carries code into or out of them. */
const GUARD = /Function|Method|Class|Interface|Constructor|Enum|Struct|Trait|Impl|Lambda|Arrow|Closure|Func/;
const NOT_GUARD = /Body|Block|Call|Name|Type|Keyword|Modifier|List|Param|Signature|Invocation|Reference|Access/;

const isContainer = (n: Node | null) => !n || !n.parent || CONTAINER.test(n.type.name);
const isGuard = (n: Node) => GUARD.test(n.type.name) && !NOT_GUARD.test(n.type.name);

function firstToken(state: EditorState, lineNo: number): number | null {
  const line = state.doc.line(lineNo);
  const indent = /^\s*/.exec(line.text)![0].length;
  return indent === line.length ? null : line.from + indent;
}

/** The statement (or member, comment, block-closing brace) that starts at the first token of a line. */
function statementStartingAt(state: EditorState, lineNo: number): Node | null {
  const pos = firstToken(state, lineNo);
  if (pos === null) return null;
  for (let n: Node | null = syntaxTree(state).resolveInner(pos, 1); n && n.parent; n = n.parent) {
    if (n.from !== pos) return null;
    if (isContainer(n.parent)) return n;
  }
  return null;
}

/** Lines a moved statement stops at: blank lines, statement starts and closing braces of blocks. */
const isStopLine = (state: EditorState, lineNo: number) =>
  firstToken(state, lineNo) === null || !!statementStartingAt(state, lineNo);

/** The statement containing the first token of the caret line. */
function statementAround(state: EditorState, pos: number): Node | null {
  const start = firstToken(state, state.doc.lineAt(pos).number);
  if (start === null) return null;
  for (let n: Node | null = syntaxTree(state).resolveInner(start, 1); n && n.parent; n = n.parent)
    if (isContainer(n.parent)) return n;
  return null;
}

/** The statement ending on a line (at its last token). */
function statementEndingOn(state: EditorState, lineNo: number): Node | null {
  const line = state.doc.line(lineNo);
  const end = line.from + line.text.trimEnd().length;
  if (end === line.from) return null;
  for (let n: Node | null = syntaxTree(state).resolveInner(end, -1); n && n.parent; n = n.parent) {
    if (isContainer(n.parent)) return state.doc.lineAt(n.to).number === lineNo ? n : null;
  }
  return null;
}

/** A function / class (or a statement holding one, e.g. a call with a callback) moves as one unit. */
function holdsGuard(n: Node): boolean {
  if (isGuard(n)) return true;
  for (let c = n.firstChild; c; c = c.nextSibling) if (!CONTAINER.test(c.type.name) && holdsGuard(c)) return true;
  return false;
}

/** Moving `cur` across lines `[s, e]` would carry it into or out of a function / class. */
function crossesGuard(state: EditorState, cur: Node, s: number, e: number): boolean {
  const from = state.doc.line(s).from;
  const to = state.doc.line(e).to;
  let crosses = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (crosses) return false;
      if (!isGuard(n.node)) return;
      if (n.from <= cur.from && n.to >= cur.to) {
        const gs = state.doc.lineAt(n.from).number;
        const ge = state.doc.lineAt(n.to).number;
        if ((gs >= s && gs <= e) || (ge >= s && ge <= e)) crosses = true;
      } else if (n.from < from || n.to > to) crosses = true;
    },
  });
  return crosses;
}

/** Comment lines directly above line `a` (a declaration's doc comment moves with it). */
function leadingCommentStart(state: EditorState, a: number): number {
  while (a > 1) {
    const n = statementStartingAt(state, a - 1);
    if (!n || !/Comment/.test(n.type.name)) break;
    a = state.doc.lineAt(n.from).number;
  }
  return a;
}

export type StatementMove = { spec: TransactionSpec } | "noop" | "line";

/**
 * Move Statement as in IDEA: the statement around the caret (whole lines)
 * moves past the next statement; into a block when the neighbour is a block
 * header or closing brace, but never into or out of a function or class (then
 * nothing happens). A neighbouring function / class (or a statement holding
 * one) is passed as a unit. The moved lines take the indentation of their new
 * place. `line` when there is no statement at the caret (move the line).
 */
export function planStatementMove(state: EditorState, up: boolean): StatementMove {
  const head = state.selection.main.head;
  const cur = statementAround(state, head);
  if (!cur) return "line";
  const doc = state.doc;
  if (/^[{}]$/.test(cur.type.name)) {
    for (let g: Node | null = cur.parent; g; g = g.parent)
      if (isGuard(g)) {
        const curLine = doc.lineAt(cur.from).number;
        if (doc.lineAt(g.from).number === curLine || doc.lineAt(g.to).number === curLine) return "noop";
        break;
      }
  }
  let a = doc.lineAt(cur.from).number;
  const b = doc.lineAt(cur.to).number;
  if (holdsGuard(cur)) a = leadingCommentStart(state, a);
  let s: number;
  let e: number;
  if (up) {
    e = a - 1;
    if (e < 1) return "noop";
    const prev = statementEndingOn(state, e);
    if (prev && prev.from < cur.from && holdsGuard(prev)) s = leadingCommentStart(state, doc.lineAt(prev.from).number);
    else {
      s = e;
      while (s >= 1 && !isStopLine(state, s)) s--;
      if (s < 1) return "noop";
    }
  } else {
    s = b + 1;
    if (s > doc.lines) return "noop";
    const next = statementStartingAt(state, s);
    if (next && next.to > cur.to && holdsGuard(next)) e = doc.lineAt(next.to).number;
    else {
      e = s + 1;
      while (e <= doc.lines && !isStopLine(state, e)) e++;
      e--;
    }
  }
  if (crossesGuard(state, cur, s, e)) return "noop";
  const moved: LineSpan = { from: doc.line(a).from, to: doc.line(b).to };
  const other: LineSpan = { from: doc.line(s).from, to: doc.line(e).to };
  const [first, second] = up ? [other, moved] : [moved, other];
  const insert = state.sliceDoc(second.from, second.to) + state.lineBreak + state.sliceDoc(first.from, first.to);
  const changes = state.changes({ from: first.from, to: second.to, insert });
  const movedFrom = up ? first.from : first.from + (second.to - second.from) + state.lineBreak.length;
  const after = state.update({ changes }).state;
  const reindent = shiftToIndentation(after, movedFrom, movedFrom + (moved.to - moved.from));
  const caret = movedFrom + (head - moved.from);
  return {
    spec: {
      changes: reindent ? changes.compose(reindent) : changes,
      selection: EditorSelection.cursor(reindent ? reindent.mapPos(caret, 1) : caret),
      scrollIntoView: true,
      userEvent: "move.line",
    },
  };
}

/** Shifts the lines of `[from, to]` so the first one gets the indentation the language computes for it. */
function shiftToIndentation(state: EditorState, from: number, to: number) {
  if (!syntaxTree(state).length) return null;
  const first = state.doc.lineAt(from);
  const proper = getIndentation(state, first.from);
  if (proper === null) return null;
  const delta = proper - countColumn(/^\s*/.exec(first.text)![0], state.tabSize);
  if (!delta) return null;
  const changes: ChangeSpec[] = [];
  for (let pos = from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    pos = line.to + 1;
    const ws = /^\s*/.exec(line.text)![0];
    if (ws.length === line.length) continue;
    const col = Math.max(0, countColumn(ws, state.tabSize) + delta);
    changes.push({ from: line.from, to: line.from + ws.length, insert: indentString(state, col) });
  }
  return state.changes(changes);
}

function moveStatement(up: boolean): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    if (view.state.selection.ranges.length === 1 && view.state.selection.main.empty) {
      // The statement and its neighbours need a parsed tree around the caret.
      forceParsing(view, Math.min(view.state.doc.length, view.state.selection.main.head + 20_000), 100);
      const plan = planStatementMove(view.state, up);
      if (plan === "noop") return true;
      if (plan !== "line") {
        view.dispatch(plan.spec);
        return true;
      }
    }
    return up ? moveLineUp(view) : moveLineDown(view);
  };
}

export const moveStatementUp = moveStatement(true);
export const moveStatementDown = moveStatement(false);

// --- complete statement -------------------------------------------------------

export const SEMICOLON_LANGS = new Set([
  "java",
  "c",
  "cpp",
  "csharp",
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "rust",
  "php",
  "dart",
  "objective-c",
  "objective-cpp",
  "groovy",
  "zig",
]);
/** Blocks close with a keyword (`end`) or by indentation: never complete them with braces. */
export const KEYWORD_BLOCK_LANGS = new Set([
  "python",
  "gdscript",
  "ruby",
  "lua",
  "elixir",
  "haskell",
  "shellscript",
  "julia",
  "erlang",
  "fsharp",
  "ocaml",
  "ocaml.interface",
  "yaml",
  "markdown",
  "plaintext",
  "makefile",
  "cmake",
  "toml",
  "ini",
  "properties",
  "sql",
  "r",
  "perl",
  "powershell",
]);
/** A line opening an indented body in `end` / layout languages (Ruby, Lua, Elixir, Haskell…). */
const KEYWORD_HEAD =
  /\b(do(\s*\|[^|]*\|)?|then|where|of)$|^\s*(def|defp|defmodule|class|module|function|local function|if|unless|elsif|elseif|else|while|until|for|case|begin)\b/;
const BLOCK_HEAD =
  /^\s*(if|else|for|while|do|switch|try|catch|finally|fn|fun|func|function|class|struct|enum|impl|trait|interface|object|match|when|loop|unsafe|mod|namespace)\b/;

/** Offset in `text` where a trailing line comment starts (outside string literals), else `text.length`. */
export function codeEnd(text: string, lineComment: string | undefined): number {
  if (!lineComment) return text.length;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (text.startsWith(lineComment, i)) return text.slice(0, i).trimEnd().length;
  }
  return text.length;
}

export function lineCommentToken(state: EditorState, pos: number): string | undefined {
  const tokens = state.languageDataAt<{ line?: string }>("commentTokens", pos)[0];
  return tokens?.line;
}

/**
 * The text-based Complete Current Statement (⌘⇧↵) on the caret line: a `;`
 * (before a trailing comment), a `{ }` block after a block header, `:` in
 * Python, then a new line. `null` on an empty line.
 */
export function completeStatementSpec(state: EditorState, language: string): TransactionSpec | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const full = line.text.trimEnd();
  const trimmed = full.trim();
  if (!trimmed) return null;
  const comment = /^(\/\/|#|\*|\/\*|--)/.test(trimmed);
  const text = comment ? full : full.slice(0, codeEnd(full, lineCommentToken(state, line.from)));
  const unit = indentString(state, getIndentUnit(state));
  const baseIndent = /^\s*/.exec(line.text)![0];
  const br = state.lineBreak;
  const braces = !KEYWORD_BLOCK_LANGS.has(language);
  if (braces && !comment && BLOCK_HEAD.test(text) && !/[{;,]$/.test(text)) {
    const insert = ` {${br}${baseIndent}${unit}${br}${baseIndent}}`;
    const from = line.from + text.length;
    return {
      // A trailing comment moves to the end of the header line.
      changes: {
        from,
        to: line.from + full.length,
        insert: insert.slice(0, 2) + full.slice(text.length) + insert.slice(2),
      },
      selection: { anchor: from + 2 + full.length - text.length + br.length + baseIndent.length + unit.length },
      scrollIntoView: true,
      userEvent: "input.complete",
    };
  }
  let insert = "";
  if (SEMICOLON_LANGS.has(language) && !comment && text.trim() && !/[;{},:]$/.test(text)) insert = ";";
  if (
    (language === "python" || language === "gdscript") &&
    BLOCK_HEAD.test(text.replace(/^\s*(def|elif|static\s+func)\b/, "if")) &&
    !text.endsWith(":")
  )
    insert = ":";
  const opensBlock =
    text.endsWith("{") ||
    insert === ":" ||
    text.endsWith(":") ||
    (KEYWORD_BLOCK_LANGS.has(language) && KEYWORD_HEAD.test(text) && !/^\s*module\b.*\bwhere$/.test(text));
  const nextIndent = baseIndent + (opensBlock ? unit : "");
  const indentHere = getIndentation(state, line.to);
  const newline = br + (indentHere !== null && !opensBlock ? indentString(state, indentHere) : nextIndent);
  const changes: ChangeSpec[] = [];
  if (insert) changes.push({ from: line.from + text.length, insert });
  changes.push({ from: line.from + full.length, to: line.to, insert: newline });
  return {
    changes,
    selection: { anchor: line.from + full.length + insert.length + newline.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

/** ⌘⇧↵: finish the current line (closing `;` or a `{ }` block) and move to the next line. */
export function completeStatement(language: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const spec = completeStatementSpec(view.state, language);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };
}

// --- comments ------------------------------------------------------------------------

export { commentLine } from "./comments";

// --- smart keys ------------------------------------------------------------------

function newLineCommand(before: boolean): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    if (before) {
      // A new line above each caret line, indented like that line (one level deeper above a closing bracket).
      const unit = indentString(state, getIndentUnit(state));
      const tr = state.changeByRange((r) => {
        const line = state.doc.lineAt(r.head);
        const own = /^[ \t]*/.exec(line.text)![0];
        // Without a parsed language there's nothing to compute from: keep the line's indent.
        const computed = syntaxTree(state).length ? getIndentation(state, line.from) : null;
        let indent = computed !== null ? indentString(state, computed) : own;
        if (/^\s*[)\]}]/.test(line.text) && indent.length <= own.length) indent = own + unit;
        return {
          changes: { from: line.from, insert: indent + state.lineBreak },
          range: EditorSelection.cursor(line.from + indent.length),
        };
      });
      view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
      return true;
    }
    // Put each caret at the end of its line, then break and indent there.
    const atEnd = state.update({
      selection: EditorSelection.create(
        state.selection.ranges.map((r) => EditorSelection.cursor(state.doc.lineAt(r.head).to)),
        state.selection.mainIndex,
      ),
    }).state;
    let result: Transaction | null = null;
    insertNewlineAndIndent({ state: atEnd, dispatch: (tr) => (result = tr) });
    if (!result) return false;
    const tr: Transaction = result;
    view.dispatch({ changes: tr.changes, selection: tr.selection, scrollIntoView: true, userEvent: "input" });
    return true;
  };
}

/** ⇧↵: Start New Line (below the caret line, whatever the caret column). */
export const startNewLine = newLineCommand(false);
/** ⌘⌥↵: Start New Line Before Current. */
export const startNewLineBefore = newLineCommand(true);

/** ⌃⇧J: Join Lines — the next line (or the selected lines) joined with single spaces. */
export const joinLines: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const tr = state.changeByRange((r) => {
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    if (last.number === first.number || (!r.empty && r.to === last.from && last.number - 1 === first.number)) {
      if (first.number === state.doc.lines) return { range: r };
      last = state.doc.line(first.number + 1);
    } else if (!r.empty && r.to === last.from) {
      last = state.doc.line(last.number - 1);
    }
    const changes: ChangeSpec[] = [];
    let caret = r.head;
    for (let n = first.number; n < last.number; n++) {
      const cur = state.doc.line(n);
      const next = state.doc.line(n + 1);
      const trail = /[ \t]*$/.exec(cur.text)![0].length;
      const lead = /^[ \t]*/.exec(next.text)![0].length;
      const nextText = next.text.slice(lead);
      // Drop the comment marker of a joined line comment (`// a` + `// b` → `// a b`).
      const comment = /^(\/\/+|#+|--)\s?/.exec(nextText);
      const curTrim = cur.text.slice(0, cur.length - trail);
      const skip =
        comment && new RegExp(`(^|\\s)${comment[1]!.replace(/[-/#]/g, "\\$&")}`).test(curTrim) ? comment[0].length : 0;
      const sep =
        !curTrim.length || !nextText.length || /[([{]$/.test(curTrim) || /^[)\]}.,;]/.test(nextText.slice(skip))
          ? ""
          : " ";
      changes.push({ from: cur.to - trail, to: next.from + lead + skip, insert: sep });
      if (n === first.number) caret = cur.to - trail;
    }
    const set = state.changes(changes);
    return {
      changes: set,
      range: r.empty
        ? EditorSelection.cursor(set.mapPos(caret, -1))
        : EditorSelection.range(set.mapPos(r.from, 1), set.mapPos(r.to, -1)),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.join" }));
  return true;
};

/** Escape sequences keep their case: `\n` must not become `\N`. */
function caseOf(state: EditorState, from: number, to: number, lower: boolean): string {
  const text = state.sliceDoc(from, to);
  const conv = (t: string) => (lower ? t.toLowerCase() : t.toUpperCase());
  const keep: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (/Escape/.test(n.type.name)) keep.push([Math.max(n.from, from) - from, Math.min(n.to, to) - from]);
    },
  });
  if (!keep.length) return conv(text);
  let out = "";
  let pos = 0;
  for (const [a, b] of keep) {
    if (a < pos) continue;
    out += conv(text.slice(pos, a)) + text.slice(a, b);
    pos = b;
  }
  return out + conv(text.slice(pos));
}

/**
 * ⌘⇧U: Toggle Case of the selections (the word at a caret, which stays
 * selected): lower case when any of them has an upper-case letter, else upper.
 */
export const toggleCase: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const targets = state.selection.ranges.map((r) => (r.empty ? state.wordAt(r.head) : r));
  const lower = targets.some((t) => t && state.sliceDoc(t.from, t.to) !== state.sliceDoc(t.from, t.to).toLowerCase());
  const tr = state.changeByRange((r) => {
    const t = targets[state.selection.ranges.indexOf(r)];
    if (!t) return { range: r };
    const insert = caseOf(state, t.from, t.to, lower);
    const range = r.empty
      ? EditorSelection.range(t.from, t.from + insert.length)
      : EditorSelection.range(r.anchor, r.head);
    return { changes: { from: t.from, to: t.to, insert }, range };
  });
  view.dispatch(state.update(tr, { userEvent: "input.case" }));
  return true;
};

/** ⌥⇧G: Add Carets to Ends of Selected Lines. */
export const addCaretsToLineEnds: Command = (view) => {
  const { state } = view;
  const ranges: SelectionRange[] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) {
      ranges.push(r);
      continue;
    }
    const first = state.doc.lineAt(r.from).number;
    let last = state.doc.lineAt(r.to).number;
    if (last > first && state.doc.lineAt(r.to).from === r.to) last--;
    for (let n = first; n <= last; n++) ranges.push(EditorSelection.cursor(state.doc.line(n).to));
  }
  if (ranges.length === state.selection.ranges.length && state.selection.ranges.every((r) => r.empty)) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, ranges.length - 1),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

/** ⌃⇧G: Unselect Occurrence — drops the most recently added selection; a single one collapses to its caret. */
export const unselectOccurrence: Command = (view) => {
  const { state } = view;
  const sel = state.selection;
  const run = state.field(occurrenceSearch, false) ?? null;
  const effects = setOccurrenceSearch.of({ wholeWords: !!run?.wholeWords, notFound: false });
  if (sel.ranges.length < 2) {
    if (sel.main.empty) return false;
    view.dispatch({ selection: EditorSelection.cursor(sel.main.head), effects, userEvent: "select" });
    return true;
  }
  const ranges = sel.ranges.filter((_, i) => i !== sel.mainIndex);
  // The previous occurrence becomes main: the one closest before the removed one, else the last.
  const removed = sel.main.from;
  let main = ranges.length - 1;
  for (let i = ranges.length - 1; i >= 0; i--)
    if (ranges[i]!.from < removed) {
      main = i;
      break;
    }
  view.dispatch({
    selection: EditorSelection.create(ranges, main),
    effects,
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};
