/**
 * Rainbow brackets (VS Code's bracket pair colorization): `()`, `[]`, `{}`
 * coloured by nesting depth (`--syn-bracket-<n>`, cycling), unmatched ones in
 * the error colour. Strings and comments are skipped: with the syntax tree
 * when the language has one, else lexically with the language's comment
 * tokens and quotes.
 *
 * Only the viewport is decorated. The nesting state at its start comes from
 * checkpoints saved every few KB while scanning, so scrolling and typing
 * rescan from the nearest checkpoint before the change, not from the top.
 */
import { Prec, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

type Tree = ReturnType<typeof syntaxTree>;
type NodeType = Tree["type"];

/** Number of `--syn-bracket-<n>` colours the depth cycles through. */
export const BRACKET_COLORS = 3;

const CHUNK = 4096;
/** How far past the viewport to look for the closers of visible openers. */
const LOOKAHEAD = 64_000;
/** Longest comment / quote token the lexical scanner needs to see past a chunk end. */
const TOKEN_SLACK = 8;

/** Closer char code of each opener char code: `(` `[` `{`. */
const CLOSER: Record<number, number> = { 40: 41, 91: 93, 123: 125 };

/** An open bracket; the stack is a persistent list so checkpoints can share it. */
interface Opener {
  closer: number;
  pos: number;
  depth: number;
  prev: Opener | null;
}

/** Lexical mode: code, line comment, block comment, string (quote in `quote`). */
type Mode = 0 | 1 | 2 | 3;

interface ScanState {
  pos: number;
  stack: Opener | null;
  mode: Mode;
  quote: string;
}

export interface BracketMark {
  from: number;
  /** 0-based depth, or -1 for an unmatched bracket. */
  depth: number;
}

interface CommentTokens {
  line?: string;
  block?: { open: string; close: string };
}

const SKIP_NODE = /string|comment|char|rune|regexp|textblock|docstring|heredoc/i;
const skipCache = new WeakMap<NodeType, boolean>();
function skipsNode(type: NodeType): boolean {
  let v = skipCache.get(type);
  if (v === undefined) skipCache.set(type, (v = !type.isTop && SKIP_NODE.test(type.name)));
  return v;
}

/**
 * Bracket scanner of one editor: keeps the checkpoints between rebuilds and
 * drops the ones after an edit (`invalidate`).
 */
export class BracketScanner {
  private checkpoints: ScanState[] = [];
  private tree: Tree | null = null;

  /** Forget checkpoints after `pos` (first changed position of the old document). */
  invalidate(pos: number) {
    const keep = pos - TOKEN_SLACK;
    let n = this.checkpoints.length;
    while (n > 0 && this.checkpoints[n - 1]!.pos > keep) n--;
    this.checkpoints.length = n;
  }

  /** Brackets in `[from, to)` with their depth; unmatched ones get depth -1. */
  marks(state: EditorState, from: number, to: number): BracketMark[] {
    const tree = treeOf(state);
    if (tree !== this.tree) {
      // A grown tree may reinterpret what was past its old end.
      if (this.tree && tree) this.invalidate(Math.min(this.tree.length, tree.length));
      else this.checkpoints.length = 0;
      this.tree = tree;
    }
    const doc = state.doc;
    to = Math.min(to, doc.length);
    const limit = tree ? Math.min(doc.length, tree.length) : doc.length;
    const comments = tree ? {} : (state.languageDataAt<CommentTokens>("commentTokens", 0)[0] ?? {});
    const out: BracketMark[] = [];
    const s = this.start(from);
    const visit = (pos: number, depth: number) => {
      if (pos >= from && pos < to) out.push({ from: pos, depth });
    };
    this.scan(doc, tree, comments, s, Math.min(to, limit), visit);
    // Visible openers whose closer never comes are unmatched; give up (leave them coloured) past the lookahead.
    let open = s.stack;
    let shallowest = Infinity;
    for (let o = open; o && o.pos >= from; o = o.prev) shallowest = o.depth;
    if (shallowest !== Infinity) {
      const end = Math.min(limit, to + LOOKAHEAD);
      this.scan(doc, tree, comments, s, end, () => {}, shallowest);
      open = s.stack;
      if (s.pos >= doc.length && (open?.depth ?? -1) >= shallowest) {
        const unmatched = new Set<number>();
        for (let o = open; o && o.depth >= shallowest; o = o.prev) unmatched.add(o.pos);
        for (const m of out) if (unmatched.has(m.from)) m.depth = -1;
      }
    }
    return out;
  }

  private start(from: number): ScanState {
    const cps = this.checkpoints;
    let lo = 0;
    let hi = cps.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cps[mid]!.pos <= from) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best < 0 ? { pos: 0, stack: null, mode: 0, quote: "" } : { ...cps[best]! };
  }

  /**
   * Advances `s` to `end`, calling `visit` for every bracket. With `untilBelow`,
   * stops once the stack is shallower than that depth (lookahead).
   */
  private scan(
    doc: Text,
    tree: Tree | null,
    comments: CommentTokens,
    s: ScanState,
    end: number,
    visit: (pos: number, depth: number) => void,
    untilBelow = -1,
  ) {
    const cps = this.checkpoints;
    const lineFirst = comments.line ? comments.line.charCodeAt(0) : -1;
    const blockFirst = comments.block ? comments.block.open.charCodeAt(0) : -1;
    while (s.pos < end) {
      const chunkEnd = Math.min(end, (Math.floor(s.pos / CHUNK) + 1) * CHUNK);
      const base = s.pos;
      const text = doc.sliceString(base, Math.min(doc.length, chunkEnd + TOKEN_SLACK));
      const stop = chunkEnd - base;
      const skips: number[] = [];
      if (tree)
        tree.iterate({
          from: base,
          to: chunkEnd,
          enter: (n) => {
            if (!skipsNode(n.type)) return;
            skips.push(n.from - base, n.to - base);
            return false;
          },
        });
      let k = 0;
      let i = 0;
      while (i < stop) {
        if (tree) {
          while (k < skips.length && skips[k + 1]! <= i) k += 2;
          if (k < skips.length && skips[k]! <= i) {
            i = skips[k + 1]!;
            continue;
          }
        } else if (s.mode !== 0) {
          i = lexSkip(text, i, stop, s, comments);
          continue;
        }
        const ch = text.charCodeAt(i);
        if (!tree && (ch === 34 || ch === 39 || ch === 96 || ch === lineFirst || ch === blockFirst)) {
          const next = lexEnter(text, i, s, comments);
          if (next !== i) {
            i = next;
            continue;
          }
        }
        if (ch === 40 || ch === 91 || ch === 123) {
          const depth = s.stack ? s.stack.depth + 1 : 0;
          visit(base + i, depth);
          s.stack = { closer: CLOSER[ch]!, pos: base + i, depth, prev: s.stack };
        } else if (ch === 41 || ch === 93 || ch === 125) {
          if (s.stack && s.stack.closer === ch) {
            visit(base + i, s.stack.depth);
            s.stack = s.stack.prev;
            if ((s.stack?.depth ?? -1) < untilBelow) {
              s.pos = base + i + 1;
              return;
            }
          } else visit(base + i, -1);
        }
        i++;
      }
      s.pos = base + i;
      const last = cps[cps.length - 1];
      if (s.pos >= (last ? last.pos : 0) + CHUNK && s.pos <= doc.length) cps.push({ ...s });
    }
  }
}

/** The syntax tree when the editor has a language, else null (lexical scanning). */
function treeOf(state: EditorState): Tree | null {
  const tree = syntaxTree(state);
  return tree.length || state.doc.length === 0 ? tree : null;
}

/** In code at `i`: enters a comment / string and returns the index after its opening token, else `i`. */
function lexEnter(text: string, i: number, s: ScanState, c: CommentTokens): number {
  const ch = text[i]!;
  if (c.line && text.startsWith(c.line, i)) {
    s.mode = 1;
    return i + c.line.length;
  }
  if (c.block && text.startsWith(c.block.open, i)) {
    s.mode = 2;
    return i + c.block.open.length;
  }
  if (ch === '"' || ch === "`" || (ch === "'" && quoteStartsString(text, i))) {
    s.mode = 3;
    s.quote = ch;
    return i + 1;
  }
  return i;
}

/** `'` starts a string unless it ends a word (Haskell's `x'`) or has no partner on the line (Rust lifetimes). */
function quoteStartsString(text: string, i: number): boolean {
  if (i > 0 && /[\w]/.test(text[i - 1]!)) return false;
  const nl = text.indexOf("\n", i + 1);
  const close = text.indexOf("'", i + 1);
  return close >= 0 && (nl < 0 || close < nl);
}

/** Inside a comment / string at `i`: the index after its end (back in code), else `stop` (still inside). */
function lexSkip(text: string, i: number, stop: number, s: ScanState, c: CommentTokens): number {
  if (s.mode === 1 || s.mode === 2) {
    const close = s.mode === 1 ? "\n" : (c.block?.close ?? "\n");
    const at = text.indexOf(close, i);
    if (at < 0 || at >= stop) return stop;
    s.mode = 0;
    return at + close.length;
  }
  for (; i < stop; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === s.quote || (ch === "\n" && s.quote !== "`")) {
      s.mode = 0;
      return i + 1;
    }
  }
  return i;
}

/** Class of a bracket at `depth` (-1: unmatched); the palette repeats every `BRACKET_COLORS` levels. */
export function bracketClass(depth: number): string {
  return depth < 0 ? "cm-rainbow-bracket-unmatched" : `cm-rainbow-bracket-${(depth % BRACKET_COLORS) + 1}`;
}

const markCache = new Map<string, Decoration>();
function markFor(depth: number): Decoration {
  const cls = bracketClass(depth);
  let m = markCache.get(cls);
  if (!m) markCache.set(cls, (m = Decoration.mark({ class: cls })));
  return m;
}

function build(view: EditorView, scanner: BracketScanner): DecorationSet {
  const { from, to } = view.viewport;
  return Decoration.set(
    scanner.marks(view.state, from, to).map((m) => markFor(m.depth).range(m.from, m.from + 1)),
    true,
  );
}

const plugin = ViewPlugin.fromClass(
  class {
    scanner = new BracketScanner();
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view, this.scanner);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) {
        let first = Infinity;
        u.changes.iterChangedRanges((fromA) => (first = Math.min(first, fromA)));
        this.scanner.invalidate(first);
      }
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = build(u.view, this.scanner);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Rainbow brackets for one editor (Settings › Editor › Color Scheme › Rainbow brackets). */
export function rainbowBrackets(): Extension {
  // Above the syntax highlighter so the bracket colour is the innermost span.
  return Prec.high(plugin);
}
