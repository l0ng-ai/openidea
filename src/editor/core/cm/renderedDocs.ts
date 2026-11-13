/**
 * Rendered doc comments: drawn as the documentation they are, in place of their
 * source, as IDEA's "Render documentation comments".
 *
 * A rendered comment's lines are replaced by one block widget holding its HTML
 * (`docRender.ts`). Which comments are rendered is decided in two layers, as in IDEA:
 *
 * - The file's default: Settings › Editor › General › Appearance › Render
 *   documentation comments, or what View › Active Editor › Render Documentation
 *   Comments made of it for this file (the document model keeps that override, as it
 *   does the soft-wrap one). It arrives as the `renderDocComments` facet.
 * - Each comment's own gutter icon (and Toggle Rendered View at the caret), which
 *   flips that one comment away from the default. Changing the default clears them,
 *   so switching the whole file always leaves every comment in the same mode.
 *
 * Clicking the rendered text leaves the comment as it is: the text can be selected and
 * copied like any prose, and the gutter icon is the way to the source. The caret can
 * only get into a rendered comment some other way (Find, Go to Line, undo), and then,
 * as in IDEA, the comment shows its source: else its text would be edited unseen.
 *
 * As in IDEA, a comment's icon shows while the mouse is over the comment, its source
 * lines or its rendered block, or over the icon's own place in the gutter. So a file of
 * comments is not a column of icons.
 *
 * Off, which is the default, the icon still shows over a comment, so one comment can be
 * read rendered, as in IDEA. That costs typing nothing: while the file renders no
 * comments and none is flipped, its comments are found only once typing pauses
 * (`deferredScanner`), the Markdown parser is not loaded, and the gutter has a column
 * only if the file has doc comments.
 *
 * On, typing costs about as little: a keystroke away from every comment's lines only
 * moves the rendered comments along with the text, and the file is scanned again once
 * typing pauses. Anything else that changes the text (paste, undo, a reload) rebuilds at
 * once, so the comments it brings in render at once.
 */
import {
  EditorState,
  Facet,
  countColumn,
  MapMode,
  RangeSet,
  StateEffect,
  StateField,
  type ChangeSet,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { gutterIconMarkup } from "@/ui/icons";
import { emptyGutterSpacer } from "@/editor/api";
import { tx, useI18n } from "@/platform/i18n";
import { loadMarkdown, markupToHtml } from "@/editor/lsp/markdown";
import { hasContent, renderDoc, type DocComment, type DocStyle, type RenderedDoc } from "./docRender";
import { LINE_INSET } from "./lineInset";

/** The file's default: render its doc comments or not. */
export const renderDocComments = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false,
});

/** Flips the comment starting at this position away from the file's default. */
export const toggleRenderedView = StateEffect.define<number>();

/** The mouse is over the comment starting here, or (null) over none. */
const hoverDoc = StateEffect.define<number | null>();

/** Announces that the Markdown parser has loaded and the comments can be rendered again. */
const markdownLoaded = StateEffect.define<null>();

/** Announces a new UI language: titles and tooltips are drawn again in it. */
const relabel = StateEffect.define<null>();

// --- finding the comments -----------------------------------------------------

/** A doc comment opens with `/**`, except when those are an empty block comment's four characters. */
function blockDocAt(text: string): boolean {
  return text.startsWith("/**") && !text.startsWith("/**/");
}

/** rustdoc and C# `///`, and the `//!` that documents the enclosing item. */
function lineDocAt(text: string): boolean {
  return /^\/\/[/!](?!\/)/.test(text);
}

/** Comment nodes, whatever the grammar calls them: `BlockComment`, `LineComment`, `docComment`, `comment`. */
const COMMENT_NODE = /comment/i;

/** Whether only whitespace lies between two document positions. */
function adjoins(state: EditorState, from: number, to: number): boolean {
  return !state.doc.sliceString(from, to).trim();
}

/**
 * The doc comments of `state`, in document order. Only comments that have their lines
 * to themselves are listed: one sharing a line with code cannot be replaced by a block.
 *
 * A comment is assembled from the comment nodes rather than taken as one: a Lezer
 * grammar (Java, JavaScript, PHP, Rust…) gives a block comment one node, but the
 * line-based modes (Kotlin, Scala, Groovy, Dart, C#, Swift) give each of its lines a
 * node of its own. So a `/**` node opens a comment that takes in the nodes after it
 * until one closes it, and consecutive `///` lines join into one, as they are one doc
 * block in every language that has them.
 */
export function docComments(state: EditorState): DocComment[] {
  const out: DocComment[] = [];
  /** The block comment being assembled, until a node ends it with the closing marker. */
  let open: DocComment | null = null;
  const finish = (comment: DocComment) => {
    const first = state.doc.lineAt(comment.from);
    const last = state.doc.lineAt(comment.to);
    if (first.text.slice(0, comment.from - first.from).trim()) return;
    if (last.text.slice(comment.to - last.from).trim()) return;
    comment.text = state.doc.sliceString(comment.from, comment.to);
    out.push(comment);
  };
  syntaxTree(state).iterate({
    enter(node) {
      if (!COMMENT_NODE.test(node.name)) return;
      const text = state.doc.sliceString(node.from, node.to);
      if (open) {
        if (adjoins(state, open.to, node.from)) {
          open.to = node.to;
          if (text.trimEnd().endsWith("*/")) {
            finish(open);
            open = null;
          }
          return false;
        }
        // Something other than comment came first: it was never closed, so it is not one.
        open = null;
      }
      if (blockDocAt(text)) {
        const comment: DocComment = { from: node.from, to: node.to, style: "block", text };
        if (text.length > 3 && text.trimEnd().endsWith("*/")) finish(comment);
        else open = comment;
        return false;
      }
      if (!lineDocAt(text)) return false;
      const previous = out.at(-1);
      if (
        previous?.style === "line" &&
        state.doc.lineAt(previous.to).number === state.doc.lineAt(node.from).number - 1 &&
        adjoins(state, previous.to, node.from)
      ) {
        // The next line of the same run: extend it rather than starting a comment.
        previous.to = node.to;
        previous.text = state.doc.sliceString(previous.from, node.to);
        return false;
      }
      finish({ from: node.from, to: node.to, style: "line", text });
      return false;
    },
  });
  return out;
}

/**
 * The comment Toggle Rendered View acts on from `pos`: the one around it, else the one
 * right above its line (the documentation of the declaration the caret is on).
 */
export function commentAt(state: EditorState, pos: number): DocComment | null {
  const line = state.doc.lineAt(pos).number;
  for (const comment of docComments(state)) {
    if (pos >= comment.from && pos <= comment.to) return comment;
    if (state.doc.lineAt(comment.to).number === line - 1) return comment;
  }
  return null;
}

// --- per-comment flips ---------------------------------------------------------

/**
 * Start positions of the comments flipped away from the file's default, mapped through
 * edits so a flip follows its comment. A position that no longer starts a comment is
 * simply never matched.
 */
const flipped = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    if (tr.startState.facet(renderDocComments) !== tr.state.facet(renderDocComments)) return [];
    // A flip whose comment lost its opening character is gone with it; one left behind
    // would keep the feature active (scanning, its column) with nothing to show.
    let next = tr.docChanged
      ? value.flatMap((pos) => {
          const mapped = tr.changes.mapPos(pos, 1, MapMode.TrackAfter);
          return mapped === null ? [] : [mapped];
        })
      : value;
    for (const e of tr.effects) {
      if (!e.is(toggleRenderedView)) continue;
      next = next.includes(e.value) ? next.filter((pos) => pos !== e.value) : [...next, e.value];
    }
    return next;
  },
});

/** Whether the file renders its comments, or has one flipped: else there is nothing to find or draw. */
function active(state: EditorState): boolean {
  return state.facet(renderDocComments) || state.field(flipped).length > 0;
}

/** Whether the comment starting at `from` is rendered now. */
function isRendered(state: EditorState, from: number): boolean {
  return state.facet(renderDocComments) !== state.field(flipped).includes(from);
}

// --- the widget ---------------------------------------------------------------

/** A section's title as shown: translated, unless it is a tag as written (`@hide`). */
const sectionTitle = (section: RenderedDoc["sections"][number]) =>
  section.translate ? tx(section.title) : section.title;

/** Bumped when the UI language changes: widgets made before draw their titles in the old one. */
let labelEpoch = 0;

/** Whether the Markdown parser has loaded: widgets made before drew their text as plain text. */
let markdownIsLoaded = false;

/** Height of one rendered line, for the estimate of a widget not drawn yet. */
const ESTIMATED_LINE_HEIGHT = 20;

/**
 * A rendered comment. It keeps the comment's source and renders it only when the editor
 * draws it, which is when it scrolls into view: opening a file with a thousand comments
 * renders the dozen on screen. Until then its height is estimated from the source.
 */
class DocWidget extends WidgetType {
  /** Everything the DOM depends on, made once: the editor compares widgets on every update. */
  readonly key: string;

  constructor(
    readonly style: DocStyle,
    readonly text: string,
    /** The comment's indent, in columns. */
    readonly indent: number,
  ) {
    super();
    this.key = `${indent}\u0000${labelEpoch}\u0000${markdownIsLoaded ? 1 : 0}\u0000${style}\u0000${text}`;
  }

  override eq(other: DocWidget): boolean {
    return this.key === other.key;
  }

  /** The source's lines less its opening and closing ones: about what the rendered text takes. */
  override get estimatedHeight(): number {
    let lines = 1;
    for (let i = this.text.indexOf("\n"); i >= 0; i = this.text.indexOf("\n", i + 1)) lines++;
    return Math.max(1, this.style === "block" ? lines - 2 : lines) * ESTIMATED_LINE_HEIGHT;
  }

  override toDOM(): HTMLElement {
    const doc = renderCached(this.style, this.text) ?? { description: "", sections: [] };
    const titles = doc.sections.map(sectionTitle);
    const dom = document.createElement("div");
    dom.className = "cm-openidea-renderedDoc";
    // In the code's character width, which `docMetrics` keeps current: the DOM stays
    // right through a font size change or zoom, which does not draw the widget again.
    const left = `(${this.indent} * var(--openidea-doc-char, 1ch) + ${LINE_INSET}px)`;
    dom.style.marginLeft = `calc${left}`;
    // The content is as wide as its longest line; the comment wraps at the visible width instead.
    dom.style.maxWidth = `calc(var(--openidea-doc-width, 100%) - ${left} - ${DOC_RIGHT_GAP}px)`;
    dom.setAttribute("role", "note");
    if (doc.description) {
      const body = document.createElement("div");
      body.className = "cm-openidea-renderedDocBody";
      body.innerHTML = doc.description;
      dom.appendChild(body);
    }
    if (doc.sections.length) {
      const list = document.createElement("dl");
      list.className = "cm-openidea-renderedDocSections";
      doc.sections.forEach((section, s) => {
        section.rows.forEach((row, i) => {
          const title = document.createElement("dt");
          // The section's title heads its first row only, as IDEA lists `Params:`.
          if (i === 0) title.textContent = `${titles[s]}:`;
          list.appendChild(title);
          const value = document.createElement("dd");
          if (row.name !== null) {
            const name = document.createElement("code");
            name.textContent = row.name;
            value.appendChild(name);
          }
          if (row.type !== null) {
            if (row.name !== null) value.appendChild(document.createTextNode(" "));
            const type = document.createElement("code");
            type.className = "cm-openidea-docType";
            type.textContent = row.type;
            value.appendChild(type);
          }
          if ((row.name !== null || row.type !== null) && row.html) value.appendChild(document.createTextNode(" – "));
          const text = document.createElement("span");
          text.className = "cm-openidea-renderedDocText";
          text.innerHTML = row.html;
          value.appendChild(text);
          list.appendChild(value);
        });
      });
      dom.appendChild(list);
    }
    return dom;
  }

  /**
   * The editor leaves every event inside the widget to the browser: its text selects
   * and copies like any prose, and a click does not move the caret or switch the mode.
   */
  override ignoreEvent(): boolean {
    return true;
  }
}

// --- decorations and gutter markers -------------------------------------------

/**
 * The comment's mode switch, with IDEA's icons: lines while it is source (to render
 * it), a pencil while rendered (to edit it). The gutter takes it with the mouse, so the
 * button is not in the tab order.
 */
class ToggleMarker extends GutterMarker {
  constructor(
    readonly rendered: boolean,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof ToggleMarker && other.rendered === this.rendered && other.label === this.label;
  }

  override toDOM(): Node {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.className = "cm-openidea-docToggle";
    button.title = this.label;
    button.setAttribute("aria-label", this.label);
    button.setAttribute("aria-pressed", String(this.rendered));
    button.innerHTML = gutterIconMarkup(this.rendered ? "gutter-javadoc-edit" : "gutter-javadoc-read") ?? "";
    return button;
  }
}

/** The toggle in the UI language of the moment: a new language makes a new marker, which the gutter draws again. */
function toggleMarker(rendered: boolean): ToggleMarker {
  return new ToggleMarker(rendered, tx("Toggle Rendered View"));
}

/** Reserves the toggles' width. Not a `ToggleMarker`: the spacer is in the DOM, hidden, and must not read as a button. */
class ToggleSpacer extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement("span");
    el.style.display = "inline-block";
    el.style.width = "14px";
    return el;
  }
}

const toggleSpacer = new ToggleSpacer();

/** A doc comment, with where its first line starts and its last line ends, and whether it is rendered now. */
type PlacedComment = DocComment & { line: number; end: number; rendered: boolean };

interface DocsView {
  decorations: DecorationSet;
  /** Every doc comment, rendered or not, in document order. */
  comments: ReadonlyArray<PlacedComment>;
  /**
   * Moved along with keystrokes since the last scan, instead of found again: what the
   * parser made of them may differ, until `deferredScanner` rebuilds.
   */
  stale: boolean;
}

const INACTIVE: DocsView = { decorations: Decoration.none, comments: [], stale: false };

/** Asks for the scan a stale view is waiting for. */
const rescanDocs = StateEffect.define<null>();

/** Comments moved along with a change, as an edit elsewhere moves them; their text is unchanged. */
function mapComments(comments: ReadonlyArray<PlacedComment>, changes: ChangeSet): PlacedComment[] {
  return comments.map((c) => ({
    ...c,
    from: changes.mapPos(c.from, 1),
    to: changes.mapPos(c.to, -1),
    line: changes.mapPos(c.line, 1),
    end: changes.mapPos(c.end, -1),
  }));
}

/**
 * Whether a change can skip the scan: a keystroke (typed or deleted characters) that
 * touches no comment's lines. Everything else (paste, undo, formatting, a reload) brings
 * comments in or out at once, so it rebuilds at once; a keystroke on a comment's line
 * moves its edges. A keystroke elsewhere can still change comments (`/*` makes the rest of
 * the file one), which the scan after the pause takes in.
 */
function typedOutsideComments(view: DocsView, tr: Transaction): boolean {
  if (!(tr.isUserEvent("input.type") || tr.isUserEvent("delete"))) return false;
  const { comments } = view;
  let touches = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    // The first comment that does not end before the change.
    let lo = 0;
    let hi = comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comments[mid]!.end < fromA) lo = mid + 1;
      else hi = mid;
    }
    if (lo < comments.length && comments[lo]!.line <= toA) touches = true;
  });
  return !touches;
}

/**
 * Rendered comments by their source, shared by every editor, least recently used first.
 * A widget drawn again (scrolled back into view, or after an edit elsewhere) finds its
 * comment here instead of rendering it again. Past `RENDER_CACHE_SIZE` the least recently
 * used is dropped, so a large file does not empty the cache for the next one. Emptied
 * when the Markdown parser loads: what was rendered before it is plain text.
 */
const renderCache = new Map<string, RenderedDoc | null>();
const RENDER_CACHE_SIZE = 2000;

function renderCached(style: DocStyle, text: string): RenderedDoc | null {
  const key = style + "\u0000" + text;
  let rendered = renderCache.get(key);
  if (rendered === undefined) {
    rendered = renderDoc(text, style, (md) => markupToHtml({ kind: "markdown", value: md }));
    if (renderCache.size >= RENDER_CACHE_SIZE) renderCache.delete(renderCache.keys().next().value!);
  } else {
    // Move it to the most recently used end.
    renderCache.delete(key);
  }
  renderCache.set(key, rendered);
  return rendered;
}

/**
 * Whether a comment has anything to render, by its source. Each edit rebuilds the view
 * and asks it of every comment in the file; this keeps that to a lookup for all but the
 * comment being edited.
 */
const contentCache = new Map<string, boolean>();

function hasContentCached(style: DocStyle, text: string): boolean {
  const key = style + "\u0000" + text;
  let content = contentCache.get(key);
  if (content === undefined) {
    content = renderCache.has(key) ? renderCache.get(key) !== null : hasContent(text, style);
    if (contentCache.size >= RENDER_CACHE_SIZE * 5) contentCache.delete(contentCache.keys().next().value!);
    contentCache.set(key, content);
  }
  return content;
}

/** Exported for tests: the number of comments rendered and cached. */
export function renderCacheSize(): number {
  return renderCache.size;
}

function build(state: EditorState): DocsView {
  if (!active(state)) return INACTIVE;
  const decorations = [];
  const comments: PlacedComment[] = [];
  for (const comment of docComments(state)) {
    const first = state.doc.lineAt(comment.from);
    const last = state.doc.lineAt(comment.to);
    // A comment with nothing to render keeps its source, and its icon says so. Telling
    // which those are does not render anything: the widget renders when it is drawn.
    const rendered = isRendered(state, comment.from) && hasContentCached(comment.style, comment.text);
    comments.push({ ...comment, line: first.from, end: last.to, rendered });
    if (!rendered) continue;
    const indent = countColumn(first.text.slice(0, first.text.length - first.text.trimStart().length), state.tabSize);
    decorations.push(
      Decoration.replace({ widget: new DocWidget(comment.style, comment.text, indent), block: true }).range(
        first.from,
        last.to,
      ),
    );
  }
  return { decorations: Decoration.set(decorations), comments, stale: false };
}

/** Start of the comment the mouse is over, or null. Cleared by any edit, which moves the text under it. */
const hovered = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(hoverDoc)) value = e.value;
    return tr.docChanged && !tr.effects.some((e) => e.is(hoverDoc)) ? null : value;
  },
});

/**
 * The comments of a file that renders none, as source, with where their lines start and
 * end. Those that would render to nothing are left out: they get no icon, and a file of
 * only those no column.
 */
function placeComments(state: EditorState): PlacedComment[] {
  return docComments(state)
    .filter((c) => hasContentCached(c.style, c.text))
    .map((c) => ({
      ...c,
      line: state.doc.lineAt(c.from).from,
      end: state.doc.lineAt(c.to).to,
      rendered: false,
    }));
}

/** Replaces the comments found while the file renders none. */
const setPassive = StateEffect.define<readonly PlacedComment[]>();

/**
 * The doc comments of a file that renders none, for their icons. Rescanning the file on
 * each keystroke would make typing in a large file several times slower for a feature
 * that is off, so `deferredScanner` rescans once typing pauses; meanwhile the comments
 * found are mapped through the edits. Empty while the file renders comments: `docsField`
 * has them then.
 */
const passiveDocs = StateField.define<readonly PlacedComment[]>({
  create: (state) => (active(state) ? [] : placeComments(state)),
  update(value, tr) {
    if (active(tr.state)) return value.length ? [] : value;
    // Switched off: the comments rendered a moment ago are known only to the last scan.
    if (active(tr.startState)) return placeComments(tr.state);
    for (const e of tr.effects) if (e.is(setPassive)) return e.value;
    return tr.docChanged ? mapComments(value, tr.changes) : value;
  },
});

/**
 * Scans the file once edits and the parser have paused: a file that renders no comments,
 * for their icons; one that does, when keystrokes have only moved its comments along.
 */
const deferredScanner = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (!update.docChanged && syntaxTree(update.startState) === syntaxTree(update.state)) return;
      // Rendering and up to date: the view was just built, nothing is waiting.
      if (active(update.state) && !update.state.field(docsField).stale) return this.cancel();
      this.cancel();
      this.timer = setTimeout(() => {
        this.timer = null;
        const { state } = this.view;
        if (!active(state)) this.view.dispatch({ effects: setPassive.of(placeComments(state)) });
        else if (state.field(docsField).stale) this.view.dispatch({ effects: rescanDocs.of(null) });
      }, RESCAN_DELAY);
    }
    cancel() {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }
    destroy() {
      this.cancel();
    }
  },
);

/** How long edits and parsing must pause before the file is scanned again. */
const RESCAN_DELAY = 300;

/** Every doc comment of the file, as last found. */
function placedComments(state: EditorState): ReadonlyArray<PlacedComment> {
  return active(state) ? state.field(docsField).comments : state.field(passiveDocs);
}

/**
 * The source-mode toggle, beside the source comment the mouse is over, if it is over one
 * that has something to render: one that would render to nothing stays source anyway.
 */
function sourceToggle(state: EditorState): RangeSet<GutterMarker> {
  const at = state.field(hovered);
  const comment = at === null ? null : placedComments(state).find((c) => c.from === at && !c.rendered);
  if (!comment || (!active(state) && !hasContentCached(comment.style, comment.text))) return RangeSet.empty;
  return RangeSet.of([toggleMarker(false).range(comment.line)]);
}

/** The comment whose lines, source or rendered, make up part of the line block `[from, to]`. */
function commentOverlapping(state: EditorState, from: number, to: number): number | null {
  return placedComments(state).find((c) => from <= c.to && to >= c.line)?.from ?? null;
}

/**
 * Follows the mouse over the editor, text and gutters alike, by the line block under it,
 * so a comment's icon shows wherever on its lines the mouse is.
 */
const hoverTracker = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.dom.addEventListener("mousemove", this.move);
      view.dom.addEventListener("mouseleave", this.leave);
    }
    move = (event: MouseEvent) => {
      const { view } = this;
      if (!placedComments(view.state).length) return;
      const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
      const inside = event.clientY - view.documentTop <= block.bottom && event.clientY >= view.documentTop;
      this.set(inside ? commentOverlapping(view.state, block.from, block.to) : null);
    };
    leave = () => this.set(null);
    set(at: number | null) {
      if (this.view.state.field(hovered) !== at) this.view.dispatch({ effects: hoverDoc.of(at) });
    }
    destroy() {
      this.view.dom.removeEventListener("mousemove", this.move);
      this.view.dom.removeEventListener("mouseleave", this.leave);
    }
  },
);

/** The comment ranges rendered in place of their source, as `[from, to]` offsets. Exported for tests. */
export function renderedRanges(state: EditorState): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  state.field(docsField).decorations.between(0, state.doc.length, (from, to) => void out.push([from, to]));
  return out;
}

const docsField = StateField.define<DocsView>({
  create: build,
  update(value, tr) {
    if (tr.effects.some((e) => e.is(markdownLoaded))) renderCache.clear();
    if (
      tr.reconfigured ||
      tr.effects.some((e) => e.is(toggleRenderedView) || e.is(markdownLoaded) || e.is(relabel) || e.is(rescanDocs))
    )
      return build(tr.state);
    if (tr.docChanged) {
      // A keystroke away from every comment moves them along; the scan waits for a pause.
      if (active(tr.state) && typedOutsideComments(value, tr))
        return {
          decorations: value.decorations.map(tr.changes),
          comments: mapComments(value.comments, tr.changes),
          stale: true,
        };
      return build(tr.state);
    }
    // The parser finishing more of the file can bring comments it had not reached: built
    // at once, so a file opens with the comments on screen rendered, unless keystrokes
    // already have the scan waiting for a pause.
    if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) return value.stale ? value : build(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

const toggleGutter = gutter({
  class: "cm-openidea-docToggles",
  // Comments left as source: their first line is a text line, which reads these markers.
  // Asked again on every update, so the icon follows the mouse.
  markers: (view) => sourceToggle(view.state),
  // Rendered comments: a block widget is not a text line, and the gutter never looks at
  // `markers` for one, only at this.
  widgetMarker: (view, widget, block) =>
    widget instanceof DocWidget && view.state.field(hovered) === commentOverlapping(view.state, block.from, block.to)
      ? toggleMarker(true)
      : null,
  // The widget markers are asked for only when the gutter redraws, which it must when the
  // mouse moves on, or the language changes.
  lineMarkerChange: (update) =>
    update.startState.field(hovered) !== update.state.field(hovered) ||
    update.transactions.some((tr) => tr.effects.some((e) => e.is(relabel))),
  // A file without doc comments gets no column at all; one with them keeps its column
  // while the icon comes and goes, so the text does not shift.
  initialSpacer: (view) => (placedComments(view.state).length ? toggleSpacer : emptyGutterSpacer),
  updateSpacer: (_spacer, update) => (placedComments(update.state).length ? toggleSpacer : emptyGutterSpacer),
  domEventHandlers: {
    mousedown(view, block, event) {
      const target = event.target instanceof Element ? event.target.closest(".cm-openidea-docToggle") : null;
      if ((event as MouseEvent).button !== 0 || !target) return false;
      // A file that renders none may not have been scanned since its last edit: the flip
      // must land on where its comment starts now.
      const comment = active(view.state)
        ? commentOverlapping(view.state, block.from, block.to)
        : (placeComments(view.state).find((c) => block.from <= c.to && block.to >= c.line)?.from ?? null);
      if (comment === null) return false;
      event.preventDefault();
      view.dispatch({ effects: toggleRenderedView.of(comment) });
      return true;
    },
  },
});

/**
 * Until the Markdown parser has loaded, a comment renders as plain text. It loads the
 * first time the editor renders anything, so an editor that never does never loads it,
 * and each that does waits for it once and then rebuilds.
 */
const markdownReady = ViewPlugin.fromClass(
  class {
    alive = true;
    started = false;
    constructor(readonly view: EditorView) {
      this.start();
    }
    update(update: ViewUpdate) {
      if (!this.started && (update.docChanged || update.transactions.length)) this.start();
    }
    start() {
      if (!active(this.view.state)) return;
      this.started = true;
      void loadMarkdown()
        .then(() => {
          markdownIsLoaded = true;
          if (this.alive) this.view.dispatch({ effects: markdownLoaded.of(null) });
        })
        .catch(() => {});
    }
    destroy() {
      this.alive = false;
    }
  },
);

/**
 * A selection that ends inside a rendered comment shows that comment's source. A click
 * cannot put it there (the widget keeps its events); Find, Go to Line or undo can, and
 * the text they land on must be visible to be edited. The edges are outside: arrow keys
 * stop there on their way past.
 */
const showSourceAtCaret = EditorState.transactionExtender.of((tr: Transaction) => {
  if (!tr.selection) return null;
  const docs = tr.startState.field(docsField, false);
  if (!docs?.comments.length) return null;
  const map = (pos: number, assoc: number) => (tr.docChanged ? tr.changes.mapPos(pos, assoc) : pos);
  const effects = [];
  for (const c of docs.comments) {
    if (!c.rendered) continue;
    const from = map(c.line, 1);
    const to = map(c.end, -1);
    if (tr.selection.ranges.some((r) => r.head > from && r.head < to))
      effects.push(toggleRenderedView.of(map(c.from, 1)));
  }
  return effects.length ? { effects } : null;
});

/** Draws titles and tooltips again when the UI language changes. */
const languageWatcher = ViewPlugin.fromClass(
  class {
    readonly unsubscribe: () => void;
    constructor(view: EditorView) {
      this.unsubscribe = useI18n.subscribe((next, previous) => {
        if (next.locale !== previous.locale || next.texts !== previous.texts) {
          labelEpoch++;
          view.dispatch({ effects: relabel.of(null) });
        }
      });
    }
    destroy() {
      this.unsubscribe();
    }
  },
);

/** Toggle Rendered View at the caret: the comment around it or right above its line. */
export function toggleRenderedViewAtCaret(view: EditorView): boolean {
  const comment = commentAt(view.state, view.state.selection.main.head);
  if (!comment) return false;
  // One with nothing to render would stay source, and its flip would linger to no end.
  if (!isRendered(view.state, comment.from) && !hasContentCached(comment.style, comment.text)) return false;
  view.dispatch({ effects: toggleRenderedView.of(comment.from) });
  return true;
}

/**
 * Colours come from the colour scheme's doc comment attributes, as IDEA's rendered view
 * takes them: the text is the comment's colour (`--syn-doc-comment`) and code and names
 * are a tag value's (`--syn-doc-comment-tag-value`). So the rendered comment reads like
 * the source one, and follows the theme and any Color Scheme edit.
 */
/** Space kept right of a rendered comment, before the visible edge. */
const DOC_RIGHT_GAP = 24;

/**
 * Publishes on the content the visible width of the text area, `--openidea-doc-width`,
 * and the code's character width, `--openidea-doc-char`. A block widget is as wide as
 * the content, which without soft wraps is as wide as the longest line, so a rendered
 * comment needs the first to wrap where the reader can see, as IDEA's does; it indents
 * by the second, which a font size change or zoom changes. Horizontal scrolling leaves
 * both unchanged.
 */
const docMetrics = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.measure();
    }
    update(update: ViewUpdate) {
      if (update.geometryChanged) this.measure();
    }
    measure() {
      this.view.requestMeasure({
        key: this,
        read: (view) => ({
          width: view.scrollDOM.clientWidth - view.contentDOM.offsetLeft,
          char: view.defaultCharacterWidth,
        }),
        write: ({ width, char }, view) => {
          const style = view.contentDOM.style;
          const widthValue = `${Math.max(0, Math.floor(width))}px`;
          if (style.getPropertyValue("--openidea-doc-width") !== widthValue)
            style.setProperty("--openidea-doc-width", widthValue);
          const charValue = `${char}px`;
          if (style.getPropertyValue("--openidea-doc-char") !== charValue)
            style.setProperty("--openidea-doc-char", charValue);
        },
      });
    }
  },
);

const docsTheme = EditorView.theme({
  ".cm-openidea-renderedDoc": {
    // No vertical margin: the editor measures a block widget by its border box, so a
    // margin would push every line below it away from its line number.
    margin: "0",
    // The content keeps its whitespace (`pre`); prose reflows instead, so the comment's
    // own line breaks do not carry over and its paragraphs wrap at the visible width.
    whiteSpace: "normal",
    overflowWrap: "break-word",
    padding: "4px 0 6px 12px",
    borderLeft: "2px solid var(--border)",
    color: "var(--syn-doc-comment)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-ui)",
    lineHeight: "1.55",
    cursor: "auto",
    WebkitUserSelect: "text",
    userSelect: "text",
  },
  ".cm-openidea-renderedDoc p": { margin: "0 0 6px" },
  ".cm-openidea-renderedDoc p:last-child": { marginBottom: "0" },
  ".cm-openidea-renderedDoc code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    color: "var(--syn-doc-comment-tag-value)",
    padding: "0 4px",
    borderRadius: "var(--radius-small)",
    background: "var(--bg-elev)",
    border: "1px solid var(--border)",
  },
  ".cm-openidea-renderedDoc pre": {
    margin: "0 0 6px",
    whiteSpace: "pre",
    padding: "6px 8px",
    overflowX: "auto",
    borderRadius: "var(--radius-small)",
    background: "var(--bg-elev)",
  },
  ".cm-openidea-renderedDoc pre code": { padding: "0", background: "none", border: "none" },
  ".cm-openidea-renderedDoc ul, .cm-openidea-renderedDoc ol": { margin: "0 0 6px", paddingLeft: "20px" },
  // As specific as the code rule it must beat, or a link takes the plain code colour.
  ".cm-openidea-renderedDoc code.cm-openidea-docLink": { color: "var(--accent)" },
  ".cm-openidea-renderedDocSections": {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: "2px 8px",
    margin: "8px 0 0",
  },
  ".cm-openidea-renderedDoc code.cm-openidea-docType": { color: "var(--syn-doc-comment)" },
  ".cm-openidea-renderedDocSections dt": { color: "var(--syn-doc-comment)" },
  ".cm-openidea-renderedDocSections dd": { margin: "0" },
  ".cm-openidea-renderedDocText p": { display: "inline", margin: "0" },
  ".cm-openidea-docToggles .cm-gutterElement": {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "0 2px",
  },
  ".cm-openidea-docToggle": {
    display: "inline-flex",
    alignItems: "center",
    height: "var(--openidea-editor-line-height, var(--lh-code))",
    padding: "0",
    border: "none",
    background: "none",
    color: "var(--fg-muted)",
    cursor: "pointer",
  },
  ".cm-openidea-docToggle:hover": { color: "var(--fg-strong)" },
});

/** Installed always; a file without doc comments gets no column and no decorations. */
export const renderedDocsExtension: Extension = [
  flipped,
  docsField,
  passiveDocs,
  deferredScanner,
  hovered,
  hoverTracker,
  showSourceAtCaret,
  toggleGutter,
  markdownReady,
  languageWatcher,
  docMetrics,
  docsTheme,
];
