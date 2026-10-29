/**
 * IDEA's side-by-side diff without alignment padding: each pane scrolls on its
 * own, scrolling one carries the other along through the changes
 * (SyncScrollSupport), and the divider between them draws a curved band per
 * change (DiffDividerDrawUtil) with the ">>" / "<<" arrows on it. Changed lines
 * tint their gutters instead of showing a change bar.
 */
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { getChunks, type Chunk, type MergeView } from "@codemirror/merge";
import { changedLineGutters } from "./cm";
import { arrowButton } from "./diffControls";

type Side = "a" | "b";

/** A stretch of both documents in document pixels: unchanged text, or a change. */
export interface Band {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  changed: boolean;
}

/** Pixel [top, bottom] of a chunk's range in `view`; an empty range is the boundary it sits on. */
function extent(view: EditorView, from: number, to: number): [number, number] {
  const len = view.state.doc.length;
  if (from > len) {
    const end = view.lineBlockAt(len).bottom;
    return [end, end];
  }
  const top = view.lineBlockAt(from).top;
  return from >= to ? [top, top] : [top, view.lineBlockAt(Math.min(to - 1, len)).bottom];
}

/** First index in `[0, n)` for which `past` holds, given that it holds for a suffix. */
function firstIndex(n: number, past: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (past(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The stretch of both documents around `y` of side `from`, from the top to
 * `endA` / `endB`: unchanged text, or a change (BaseSyncScrollable.processHelper).
 * Only the chunks next to `y` are measured.
 */
export function bandAt(
  chunks: readonly Chunk[],
  extentA: (c: Chunk) => [number, number],
  extentB: (c: Chunk) => [number, number],
  endA: number,
  endB: number,
  y: number,
  from: Side,
): Band {
  const master = from === "a" ? extentA : extentB;
  const next = firstIndex(chunks.length, (i) => master(chunks[i]!)[0] > y);
  let a = 0;
  let b = 0;
  const prev = chunks[next - 1];
  if (prev) {
    const [a0, a1] = extentA(prev);
    const [b0, b1] = extentB(prev);
    if (y < (from === "a" ? a1 : b1)) return { a0, a1, b0, b1, changed: true };
    a = a1;
    b = b1;
  }
  const c = chunks[next];
  return c
    ? { a0: a, a1: extentA(c)[0], b0: b, b1: extentB(c)[0], changed: false }
    : { a0: a, a1: endA, b0: b, b1: endB, changed: false };
}

/**
 * The position on the other side matching `y` of side `from`
 * (BaseSyncScrollable.transferLine, in pixels): unchanged text maps through,
 * and inside a change the other side follows line by line, then waits at the
 * end of its shorter part.
 */
export function transferY(bands: readonly Band[], y: number, from: Side): number {
  const fromA = from === "a";
  const band = bands.find((b) => y < (fromA ? b.a1 : b.b1)) ?? bands[bands.length - 1]!;
  const [m0, m1, s0, s1] = fromA ? [band.a0, band.a1, band.b0, band.b1] : [band.b0, band.b1, band.a0, band.a1];
  if (band.changed) return Math.min(s0 + (y - m0), s1);
  return m1 > m0 ? s0 + ((y - m0) * (s1 - s0)) / (m1 - m0) : s0;
}

type ChangeKind = "inserted" | "deleted" | "modified";
const kindOf = (c: Chunk): ChangeKind => (c.fromA === c.toA ? "inserted" : c.fromB === c.toB ? "deleted" : "modified");

/** The divider band between [a0, a1] on the left and [b0, b1] on the right (DiffDrawUtil.makeCurve). */
export function bandPath(w: number, a0: number, a1: number, b0: number, b1: number): string {
  // An empty side is a 2px sliver on its boundary.
  if (a1 - a0 < 2) [a0, a1] = [a0 - 1, a0 + 1];
  if (b1 - b0 < 2) [b0, b1] = [b0 - 1, b0 + 1];
  const c1 = w * 0.3;
  const c2 = w * 0.7;
  return `M0 ${a0}C${c1} ${a0} ${c2} ${b0} ${w} ${b0}L${w} ${b1}C${c2} ${b1} ${c1} ${a1} 0 ${a1}Z`;
}

const gapMark = (kind: ChangeKind, end: boolean) =>
  Decoration.line({ class: `cm-diffGap cm-diffGap-${kind}${end ? " cm-diffGapEnd" : ""}` });

/** A line where the other side has lines this one lacks, as in IDEA's empty-side marker. */
function gapDeco(view: EditorView): DecorationSet {
  const info = getChunks(view.state);
  if (!info?.side) return Decoration.none;
  const isA = info.side === "a";
  const { doc } = view.state;
  const { from: vpFrom, to: vpTo } = view.viewport;
  const builder = new RangeSetBuilder<Decoration>();
  for (const c of info.chunks) {
    const [from, to] = isA ? [c.fromA, c.toA] : [c.fromB, c.toB];
    if (from !== to) continue;
    if (from > vpTo) break;
    if (from < vpFrom) continue;
    // Past the end of a document without a final line break: below its last line.
    const line = doc.lineAt(Math.min(from, doc.length));
    builder.add(line.from, line.from, gapMark(kindOf(c), from > doc.length));
  }
  return builder.finish();
}

const gapMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = gapDeco(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || getChunks(u.startState)?.chunks !== getChunks(u.state)?.chunks)
        this.decorations = gapDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const SVG = "http://www.w3.org/2000/svg";
const ARROW_HEIGHT = 16;
let gradients = 0;

export interface UnalignedPanesOptions {
  /** Scrolling one pane carries the other along. */
  sync: boolean;
  /** Divider arrows toward the editable sides; `apply` copies chunk `index` from `source`. */
  arrows?: { toA: boolean; toB: boolean; apply(index: number, source: Side): void };
}

/**
 * Scroll synchronization and the divider for a MergeView whose panes are not
 * padded into alignment. Add `extension` to both editors, then `attach` the view.
 */
export class UnalignedPanes {
  readonly extension: Extension;
  private mv: MergeView | null = null;
  private readonly divider = document.createElement("div");
  private readonly svg = document.createElementNS(SVG, "svg");
  private readonly bandLayer = document.createElementNS(SVG, "g");
  private readonly gradient = `cm-diffBandGradient-${++gradients}`;
  private readonly arrowEls = new Map<string, HTMLButtonElement>();
  /** Scroll position each pane was last moved to by the other one, to tell its echo from the user. */
  private readonly moved: Record<Side, { top: number | null; left: number | null }> = {
    a: { top: null, left: null },
    b: { top: null, left: null },
  };
  private sync: boolean;
  private frame = -1;
  private resize: ResizeObserver | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly opts: UnalignedPanesOptions) {
    this.sync = opts.sync;
    this.extension = [gapMarks, changedLineGutters, EditorView.updateListener.of(() => this.schedule())];
    this.divider.className = "cm-diffDivider";
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.innerHTML =
      `<defs><linearGradient id="${this.gradient}" x1="0" x2="1">` +
      `<stop offset="0" class="cm-diffBandStopA"/><stop offset="1" class="cm-diffBandStopB"/>` +
      `</linearGradient></defs>`;
    this.svg.appendChild(this.bandLayer);
    this.divider.appendChild(this.svg);
  }

  attach(mv: MergeView) {
    this.mv = mv;
    // MergeView pads the panes into alignment on each measure; these panes stay unpadded.
    (mv as unknown as { measure(): void }).measure = () => {};
    mv.a.dom.parentElement!.after(this.divider);
    for (const side of ["a", "b"] as const) {
      const el = this.view(side).scrollDOM;
      const onScroll = () => this.scrolled(side);
      el.addEventListener("scroll", onScroll, { passive: true });
      this.cleanup.push(() => el.removeEventListener("scroll", onScroll));
    }
    // The divider scrolls the right pane (and, when synchronized, through it the left one).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      mv.b.scrollDOM.scrollBy(e.deltaX, e.deltaY);
    };
    this.divider.addEventListener("wheel", onWheel, { passive: false });
    this.cleanup.push(() => this.divider.removeEventListener("wheel", onWheel));
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(this.divider);
    }
    requestAnimationFrame(() => this.resync());
  }

  /** Brings the left pane in line with the right one. */
  resync() {
    if (this.mv && this.sync) this.follow("b");
    this.schedule();
  }

  /** Turns synchronized scrolling on (bringing the left pane in line) or off. */
  setSync(on: boolean) {
    if (on === this.sync) return;
    this.sync = on;
    this.resync();
  }

  destroy() {
    if (this.frame >= 0) cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    for (const f of this.cleanup) f();
    this.divider.remove();
    this.mv = null;
  }

  private view(side: Side): EditorView {
    return side === "a" ? this.mv!.a : this.mv!.b;
  }

  private scrolled(side: Side) {
    const el = this.view(side).scrollDOM;
    const moved = this.moved[side];
    const echo =
      (moved.top !== null || moved.left !== null) &&
      (moved.top === null || Math.abs(el.scrollTop - moved.top) <= 1) &&
      (moved.left === null || Math.abs(el.scrollLeft - moved.left) <= 1);
    moved.top = moved.left = null;
    if (!echo && this.sync) this.follow(side);
    this.schedule();
  }

  private bandAt(y: number, from: Side): Band {
    const { a, b, chunks } = this.mv!;
    return bandAt(
      chunks,
      (c) => extent(a, c.fromA, c.toA),
      (c) => extent(b, c.fromB, c.toB),
      a.lineBlockAt(a.state.doc.length).bottom,
      b.lineBlockAt(b.state.doc.length).bottom,
      y,
      from,
    );
  }

  /** Scrolls the other pane to match `from`, anchored a third down the pane (SyncScrollSupport). */
  private follow(from: Side) {
    const to: Side = from === "a" ? "b" : "a";
    const master = this.view(from);
    const slave = this.view(to);
    const anchor = master.scrollDOM.clientHeight / 3;
    const at = master.scrollDOM.scrollTop + anchor - docOffset(master);
    const y = transferY([this.bandAt(at, from)], at, from);
    const el = slave.scrollDOM;
    const top = Math.max(0, Math.min(y + docOffset(slave) - anchor, el.scrollHeight - el.clientHeight));
    const moved = this.moved[to];
    if (Math.abs(el.scrollTop - top) >= 1) {
      const before = el.scrollTop;
      el.scrollTop = top;
      if (el.scrollTop !== before) moved.top = el.scrollTop;
    }
    const left = master.scrollDOM.scrollLeft;
    if (el.scrollLeft !== left) {
      const before = el.scrollLeft;
      el.scrollLeft = left;
      if (el.scrollLeft !== before) moved.left = el.scrollLeft;
    }
  }

  private schedule() {
    if (this.frame < 0 && this.mv) this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    this.frame = -1;
    const mv = this.mv;
    if (!mv) return;
    const rect = this.divider.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (!w || !h) return;
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const offA = mv.a.documentTop - rect.top;
    const offB = mv.b.documentTop - rect.top;
    const lineHeight = mv.a.defaultLineHeight;
    const arrowTop = (y0: number, y1: number) =>
      y1 - y0 < 2 ? y0 - ARROW_HEIGHT / 2 : y0 + (Math.min(lineHeight, y1 - y0) - ARROW_HEIGHT) / 2;
    const arrows = this.opts.arrows;
    const shown = new Set<string>();
    let paths = "";
    const { chunks } = mv;
    // Chunks run down both panes in order: start at the first one reaching into either.
    const first = Math.min(
      firstIndex(chunks.length, (i) => extent(mv.a, chunks[i]!.fromA, chunks[i]!.toA)[1] + offA >= -1),
      firstIndex(chunks.length, (i) => extent(mv.b, chunks[i]!.fromB, chunks[i]!.toB)[1] + offB >= -1),
    );
    for (let i = first; i < chunks.length; i++) {
      const c = chunks[i]!;
      const [a0, a1] = extent(mv.a, c.fromA, c.toA).map((y) => y + offA) as [number, number];
      const [b0, b1] = extent(mv.b, c.fromB, c.toB).map((y) => y + offB) as [number, number];
      if (a0 > h + 1 && b0 > h + 1) break;
      if (a1 < -1 && b1 < -1) continue;
      const kind = kindOf(c);
      const fill = kind === "modified" ? ` fill="url(#${this.gradient})"` : "";
      const mid = (a0 + a1) / 2;
      const midB = (b0 + b1) / 2;
      paths +=
        `<path class="cm-diffBand cm-diffBand-${kind}"${fill} d="${bandPath(w, a0, a1, b0, b1)}"/>` +
        `<path class="cm-diffBandLine cm-diffBand-${kind}" d="M0 ${mid}C${w * 0.3} ${mid} ${w * 0.7} ${midB} ${w} ${midB}"/>`;
      if (arrows?.toB) this.placeArrow(shown, i, "a-to-b", arrowTop(a0, a1), h);
      if (arrows?.toA) this.placeArrow(shown, i, "b-to-a", arrowTop(b0, b1), h);
    }
    this.bandLayer.innerHTML = paths;
    for (const [key, el] of this.arrowEls)
      if (!shown.has(key)) {
        el.remove();
        this.arrowEls.delete(key);
      }
  }

  private placeArrow(shown: Set<string>, index: number, dir: "a-to-b" | "b-to-a", top: number, h: number) {
    if (top < -ARROW_HEIGHT || top > h) return;
    const key = `${index}${dir}`;
    let el = this.arrowEls.get(key);
    if (!el) {
      el = arrowButton(dir, (i) => this.opts.arrows?.apply(i, dir === "a-to-b" ? "a" : "b"));
      this.arrowEls.set(key, el);
      this.divider.appendChild(el);
    }
    el.dataset.chunk = String(index);
    el.style.top = `${top}px`;
    shown.add(key);
  }
}

/** Offset of the document's top within the pane's scrolled content. */
function docOffset(view: EditorView): number {
  return view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
}
