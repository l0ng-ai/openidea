/**
 * Rainbow brackets (VS Code's bracket pair colorization): `()`, `[]`, `{}`
 * coloured by nesting depth (`--syn-bracket-<n>`, cycling through the first
 * 2–5 colours), unmatched ones in the error colour. Strings, comments and markup
 * literals are skipped: with the syntax tree when the language has one, else
 * lexically with the language's comment tokens and quotes. Interpolated
 * expressions stay visible as holes inside those literals.
 *
 * A kind switched off is still tracked, so the other brackets keep their depth;
 * it is only left uncoloured. The angle kind is the exception: off, `<` and `>`
 * are not brackets at all. On, the `<` `>` of the syntax nodes the language
 * definitions name (`[rainbow-brackets]`: type argument / parameter lists, markup
 * tags) pair up and count toward the depth of what they enclose; an element's
 * start and end tags take one depth and its content the next. Comparisons and
 * shifts are never coloured, being no such node.
 *
 * Only the viewport is decorated. The nesting state at its start comes from
 * checkpoints saved every few KB while scanning, so scrolling and typing
 * rescan from the nearest checkpoint before the change, not from the top.
 */
import { Facet, Prec, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";

type Tree = ReturnType<typeof syntaxTree>;
type NodeType = Tree["type"];

/** Number of `--syn-bracket-<n>` colours a colour scheme defines. */
export const BRACKET_COLORS = 5;
/** Colours the depth cycles through by default. */
export const DEFAULT_BRACKET_COLORS = 3;

/** Syntax nodes whose `<` `>` the angle kind colours, from the language definitions. */
export interface BracketSyntax {
  /** Nodes spanning `<` … `>` whose delimiters pair up: type argument and parameter lists. */
  angle: readonly string[];
  /** Markup tags (`<a>`, `</a>`, `<a/>`); an element's start and end tags pair up. */
  tags: readonly string[];
}

/** Settings › Editor › Color Scheme › Language Defaults › Rainbow brackets. */
export interface RainbowBracketOptions {
  round: boolean;
  square: boolean;
  curly: boolean;
  angle: boolean;
  /** Colours the depth cycles through (2–5). */
  colors: number;
  syntax: BracketSyntax;
}

export const DEFAULT_RAINBOW_OPTIONS: RainbowBracketOptions = {
  round: true,
  square: true,
  curly: true,
  angle: false,
  colors: DEFAULT_BRACKET_COLORS,
  syntax: { angle: [], tags: [] },
};

const CHUNK = 4096;
/** How far past the viewport to look for the closers of visible openers. */
const LOOKAHEAD = 64_000;
/** Longest comment / quote token the lexical scanner needs to see past a chunk end. */
const TOKEN_SLACK = 8;

/** Closer char code of each opener char code: `(` `[` `{`. */
const CLOSER: Record<number, number> = { 40: 41, 91: 93, 123: 125 };
/**
 * `closer` of an angle bracket or tag delimiter (`>`), of an element whose end tag is still
 * to come, and of an end tag without its element (its `>` is unmatched too).
 */
const GT = 62;
const ELEMENT = -1;
const LONE_GT = -2;

/** Angle events at a `<` / `>` the syntax tree marks: opens, closes, ends a start tag, starts an end tag, or `<` never closed. */
const OPEN = 0;
const CLOSE = 1;
const START_TAG_END = 2;
const END_TAG = 3;
const LONE = 4;
/** Node kinds of the angle syntax. */
const ANGLE_NODE = 1;
const TAG_NODE = 2;

/** An open bracket; the stack is a persistent list so checkpoints can share it. */
interface Opener {
  /** Closer char code; `GT` / `LONE_GT` for `<`, `ELEMENT` for an element between its tags. */
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

const SKIP_NODE =
  /string|comment|char|rune|regexp|textblock|docstring|heredoc|attributevalue|cdata|doctype|processinginst|^(FormatSpec|Text|JSXText)$/i;
const INTERPOLATION_NODE = /^(Interpolation|FormatReplacement)$/;
const skipCache = new WeakMap<NodeType, boolean>();
function skipsNode(type: NodeType): boolean {
  let v = skipCache.get(type);
  if (v === undefined) skipCache.set(type, (v = !type.isTop && SKIP_NODE.test(type.name)));
  return v;
}

/** Collects angle events (offset from `from`, event, element start) while `literalRanges` walks the tree. */
interface AngleEvents {
  doc: Text;
  kindOf: (type: NodeType) => number;
  out: number[];
}

function charAt(doc: Text, pos: number): string {
  return pos >= 0 && pos < doc.length ? doc.sliceString(pos, pos + 1) : "";
}

/** Angle events of node `n` (of angle kind `kind`) at its start, or at its end with `atEnd`. */
function angleEvents(a: AngleEvents, n: SyntaxNodeRef, kind: number, from: number, to: number, atEnd: boolean) {
  const { doc, out } = a;
  if (n.to - n.from < 2 || charAt(doc, n.from) !== "<") return;
  const closed = charAt(doc, n.to - 1) === ">";
  const endTag = kind === TAG_NODE && charAt(doc, n.from + 1) === "/";
  const pos = atEnd ? n.to - 1 : n.from;
  if (pos < from || pos >= to || (atEnd && !closed)) return;
  if (!atEnd) {
    if (!closed) out.push(pos - from, LONE, 0);
    else if (endTag) out.push(pos - from, END_TAG, n.node.parent?.from ?? -1);
    else out.push(pos - from, OPEN, 0);
    return;
  }
  let event = CLOSE;
  if (kind === TAG_NODE && !endTag && charAt(doc, n.to - 2) !== "/") {
    // A start tag opens its element only when the element has a whole end tag (not `<br>`, nor an implied end).
    const last = n.node.parent?.lastChild;
    if (
      last &&
      last.from > n.from &&
      a.kindOf(last.type) === TAG_NODE &&
      doc.sliceString(last.from, last.from + 2) === "</" &&
      charAt(doc, last.to - 1) === ">"
    )
      event = START_TAG_END;
  }
  out.push(pos - from, event, 0);
}

/**
 * Literal ranges, with holes for interpolated code (which may contain more literals); with
 * `angles`, also the angle events in `[from, to)`.
 */
function literalRanges(tree: Tree, from: number, to: number, angles?: AngleEvents): number[] {
  const ranges: number[] = [];
  const parents: boolean[] = [];
  let skipping = false;
  let start = from;
  const setSkipping = (next: boolean, pos: number) => {
    if (next === skipping) return;
    if (next) start = Math.max(from, pos);
    else if (start < Math.min(to, pos)) ranges.push(start - from, Math.min(to, pos) - from);
    skipping = next;
  };
  tree.iterate({
    from,
    to,
    enter: (n) => {
      parents.push(skipping);
      if (skipsNode(n.type)) setSkipping(true, n.from);
      else if (INTERPOLATION_NODE.test(n.name)) setSkipping(false, n.from);
      const kind = angles ? angles.kindOf(n.type) : 0;
      if (kind) angleEvents(angles!, n, kind, from, to, false);
    },
    leave: (n) => {
      setSkipping(parents.pop()!, n.to);
      const kind = angles ? angles.kindOf(n.type) : 0;
      if (kind) angleEvents(angles!, n, kind, from, to, true);
    },
  });
  return ranges;
}

/**
 * Bracket scanner of one editor: keeps the checkpoints between rebuilds and
 * drops the ones after an edit (`invalidate`).
 */
export class BracketScanner {
  private checkpoints: ScanState[] = [];
  private tree: Tree | null = null;
  /** Whether brackets with each closer char code are coloured (1). */
  private readonly shown = new Uint8Array(128);
  /** Angle node kind of each node name, or null while the angle kind is off. */
  private readonly angleNames: Map<string, number> | null = null;
  private readonly angleKinds = new WeakMap<NodeType, number>();

  constructor(readonly options: RainbowBracketOptions = DEFAULT_RAINBOW_OPTIONS) {
    this.shown[41] = +options.round;
    this.shown[93] = +options.square;
    this.shown[125] = +options.curly;
    this.shown[GT] = +options.angle;
    if (options.angle && (options.syntax.angle.length || options.syntax.tags.length)) {
      this.angleNames = new Map();
      for (const name of options.syntax.angle) this.angleNames.set(name, ANGLE_NODE);
      for (const name of options.syntax.tags) this.angleNames.set(name, TAG_NODE);
    }
  }

  /** Colours the depth cycles through. */
  get colors(): number {
    return clampColors(this.options.colors);
  }

  private readonly kindOf = (type: NodeType): number => {
    let kind = this.angleKinds.get(type);
    if (kind === undefined) this.angleKinds.set(type, (kind = this.angleNames!.get(type.name) ?? 0));
    return kind;
  };

  /** Forget checkpoints after `pos` (first changed position of the old document). */
  invalidate(pos: number) {
    const keep = pos - TOKEN_SLACK;
    let n = this.checkpoints.length;
    while (n > 0 && this.checkpoints[n - 1]!.pos > keep) n--;
    this.checkpoints.length = n;
  }

  /** The state's syntax tree (null: lexical); drops checkpoints a changed tree may reinterpret. */
  private sync(state: EditorState): Tree | null {
    const tree = treeOf(state);
    if (tree !== this.tree) {
      // A grown tree may reinterpret what was past its old end.
      if (this.tree && tree) this.invalidate(Math.min(this.tree.length, tree.length));
      else this.checkpoints.length = 0;
      this.tree = tree;
    }
    return tree;
  }

  /**
   * The innermost bracket still open at each of `positions` (ascending), or null where
   * none is, or where the position lies past the parsed syntax tree.
   */
  openAt(state: EditorState, positions: readonly number[]): (BracketMark | null)[] {
    const tree = this.sync(state);
    const doc = state.doc;
    const limit = tree ? Math.min(doc.length, tree.length) : doc.length;
    const comments = tree ? {} : (state.languageDataAt<CommentTokens>("commentTokens", 0)[0] ?? {});
    const out: (BracketMark | null)[] = [];
    let s: ScanState | null = null;
    for (const pos of positions) {
      if (pos > limit) {
        out.push(null);
        continue;
      }
      // Continue from the previous position unless a checkpoint is nearer.
      const cp = this.start(pos);
      if (!s || s.pos > pos || cp.pos > s.pos) s = cp;
      this.scan(doc, tree, comments, s, pos, () => {});
      const top = s.stack;
      const shown = top && (top.closer === ELEMENT || this.shown[top.closer]);
      out.push(shown ? { from: top.pos, depth: top.depth } : null);
    }
    return out;
  }

  /** Brackets in `[from, to)` with their depth; unmatched ones get depth -1. */
  marks(state: EditorState, from: number, to: number): BracketMark[] {
    const tree = this.sync(state);
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
        for (let o = open; o && o.depth >= shallowest; o = o.prev) if (o.closer !== ELEMENT) unmatched.add(o.pos);
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
    const shown = this.shown;
    const lineFirst = comments.line ? comments.line.charCodeAt(0) : -1;
    const blockFirst = comments.block ? comments.block.open.charCodeAt(0) : -1;
    const angles: AngleEvents | undefined = tree && this.angleNames ? { doc, kindOf: this.kindOf, out: [] } : undefined;
    while (s.pos < end) {
      const chunkEnd = Math.min(end, (Math.floor(s.pos / CHUNK) + 1) * CHUNK);
      const base = s.pos;
      const text = doc.sliceString(base, Math.min(doc.length, chunkEnd + TOKEN_SLACK));
      const stop = chunkEnd - base;
      if (angles) angles.out.length = 0;
      const skips = tree ? literalRanges(tree, base, chunkEnd, angles) : [];
      const events = angles?.out ?? [];
      let e = 0;
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
          const closer = CLOSER[ch]!;
          const depth = s.stack ? s.stack.depth + 1 : 0;
          if (shown[closer]) visit(base + i, depth);
          s.stack = { closer, pos: base + i, depth, prev: s.stack };
        } else if (ch === 41 || ch === 93 || ch === 125) {
          if (s.stack && s.stack.closer === ch) {
            if (shown[ch]) visit(base + i, s.stack.depth);
            s.stack = s.stack.prev;
            if ((s.stack?.depth ?? -1) < untilBelow) {
              s.pos = base + i + 1;
              return;
            }
          } else if (shown[ch]) visit(base + i, -1);
        } else if ((ch === 60 || ch === 62) && e < events.length) {
          while (e < events.length && events[e]! < i) e += 3;
          if (events[e] === i) {
            angleStep(s, base + i, events[e + 1]!, events[e + 2]!, visit);
            if ((s.stack?.depth ?? -1) < untilBelow) {
              s.pos = base + i + 1;
              return;
            }
          }
        }
        i++;
      }
      s.pos = base + i;
      const last = cps[cps.length - 1];
      if (s.pos >= (last ? last.pos : 0) + CHUNK && s.pos <= doc.length) cps.push({ ...s });
    }
  }
}

/** Applies the angle event `event` at `pos` (a `<` or `>`) to the stack. */
function angleStep(
  s: ScanState,
  pos: number,
  event: number,
  elementFrom: number,
  visit: (pos: number, depth: number) => void,
) {
  const top = s.stack;
  if (event === OPEN) {
    const depth = top ? top.depth + 1 : 0;
    visit(pos, depth);
    s.stack = { closer: GT, pos, depth, prev: top };
  } else if (event === LONE) visit(pos, -1);
  else if (event === END_TAG) {
    // The element's entry, past anything left open inside it; the end tag takes its depth.
    let o = top;
    while (o && !(o.closer === ELEMENT && o.pos === elementFrom)) o = o.prev;
    if (!o) {
      visit(pos, -1);
      s.stack = { closer: LONE_GT, pos, depth: top ? top.depth + 1 : 0, prev: top };
    } else {
      visit(pos, o.depth);
      s.stack = { closer: GT, pos, depth: o.depth, prev: o.prev };
    }
  } else if (top && top.closer === GT) {
    visit(pos, top.depth);
    s.stack = event === START_TAG_END ? { closer: ELEMENT, pos: top.pos, depth: top.depth, prev: top.prev } : top.prev;
  } else {
    visit(pos, -1);
    if (top && top.closer === LONE_GT) s.stack = top.prev;
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

/** A palette length within 2–`BRACKET_COLORS`. */
function clampColors(colors: number): number {
  return Number.isFinite(colors) ? Math.min(BRACKET_COLORS, Math.max(2, Math.round(colors))) : DEFAULT_BRACKET_COLORS;
}

/** Class of a bracket at `depth` (-1: unmatched); the palette repeats every `colors` levels. */
export function bracketClass(depth: number, colors = DEFAULT_BRACKET_COLORS): string {
  return depth < 0 ? "cm-rainbow-bracket-unmatched" : `cm-rainbow-bracket-${(depth % clampColors(colors)) + 1}`;
}

const markCache = new Map<string, Decoration>();
function markFor(depth: number, colors: number): Decoration {
  const cls = bracketClass(depth, colors);
  let m = markCache.get(cls);
  if (!m) markCache.set(cls, (m = Decoration.mark({ class: cls })));
  return m;
}

function build(view: EditorView, scanner: BracketScanner): DecorationSet {
  const { from, to } = view.viewport;
  const colors = scanner.colors;
  return Decoration.set(
    scanner.marks(view.state, from, to).map((m) => markFor(m.depth, colors).range(m.from, m.from + 1)),
    true,
  );
}

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const optionsFacet = Facet.define<RainbowBracketOptions, RainbowBracketOptions>({
  combine: (values) => values[0] ?? DEFAULT_RAINBOW_OPTIONS,
  compare: (a, b) =>
    a.round === b.round &&
    a.square === b.square &&
    a.curly === b.curly &&
    a.angle === b.angle &&
    a.colors === b.colors &&
    sameNames(a.syntax.angle, b.syntax.angle) &&
    sameNames(a.syntax.tags, b.syntax.tags),
});

const plugin = ViewPlugin.fromClass(
  class {
    scanner: BracketScanner;
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.scanner = new BracketScanner(view.state.facet(optionsFacet));
      this.decorations = build(view, this.scanner);
    }
    update(u: ViewUpdate) {
      const options = u.state.facet(optionsFacet);
      const reconfigured = options !== u.startState.facet(optionsFacet);
      if (reconfigured) this.scanner = new BracketScanner(options);
      else if (u.docChanged) {
        let first = Infinity;
        u.changes.iterChangedRanges((fromA) => (first = Math.min(first, fromA)));
        this.scanner.invalidate(first);
      }
      if (reconfigured || u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = build(u.view, this.scanner);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * The rainbow bracket scanner of `view`, up to date with its state, or null while
 * rainbow brackets are off: indent guides and sticky lines take bracket colours from it.
 */
export function bracketScanner(view: EditorView): BracketScanner | null {
  return view.plugin(plugin)?.scanner ?? null;
}

/** Rainbow brackets for one editor (Settings › Editor › Color Scheme › Rainbow brackets). */
export function rainbowBrackets(options: Partial<RainbowBracketOptions> = {}): Extension {
  // Above the syntax highlighter so the bracket colour is the innermost span.
  return [Prec.high(plugin), optionsFacet.of({ ...DEFAULT_RAINBOW_OPTIONS, ...options })];
}
