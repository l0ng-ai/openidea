/**
 * Always-on link styling for URLs in the terminal (Settings › Tools › Terminal ›
 * Highlight hyperlinks), as in IntelliJ's terminal: link colour + underline without hovering.
 *
 * - One xterm decoration per visible URL: `foregroundColor` recolours the cells, the
 *   decoration element (`LINK_DECORATION_CLASS`) draws the underline.
 * - Scans only the viewport, coalesced to one pass per animation frame; markers keep
 *   decorations on their line while it scrolls, and ones a screen beyond the viewport are dropped.
 * - Off in the alternate buffer (`vim`, `less`): xterm decorations only live in the normal one.
 */
import type { IBufferLine, IDecoration, IDisposable, ILink, IMarker, Terminal } from "@xterm/xterm";
import { workflowSettings } from "@/platform/workflowSettings";
import { stringOffsetToCol } from "./highlight";
import { findTerminalLinks, type TerminalLink } from "./links";

export const LINK_DECORATION_CLASS = "openidea-terminal-link";

/** 0-based cell columns `[start, end)` of `link` (string offsets) in `line`; wide CJK glyphs take two cells. */
export function linkCells(line: IBufferLine, link: TerminalLink): { start: number; end: number } {
  return { start: stringOffsetToCol(line, link.start), end: stringOffsetToCol(line, link.end) };
}

const enabled = () => workflowSettings().terminal.highlightHyperlinks;
const highlighted = (term: Terminal) => enabled() && term.buffer.active.type === "normal";

/** The xterm link for `link` on buffer row `y` (1-based), for a link provider. */
export function xtermLink(
  term: Terminal,
  line: IBufferLine,
  y: number,
  link: TerminalLink,
  activate: (event: MouseEvent) => void,
): ILink {
  const { start, end } = linkCells(line, link);
  return {
    text: link.text,
    range: { start: { x: start + 1, y }, end: { x: end, y } },
    // A highlighted URL is already underlined; a second hover underline would sit just above it.
    decorations: { underline: link.kind !== "url" || !highlighted(term), pointerCursor: true },
    activate,
  };
}

export interface LinkHighlightController extends IDisposable {
  /** Drops every decoration and redraws, e.g. after a theme or setting change. */
  refresh(): void;
  /** Runs the pending viewport pass now. */
  update(): void;
}

interface Entry {
  marker: IMarker;
  decoration: IDecoration;
  start: number;
  end: number;
}

export function installLinkHighlights(term: Terminal, color: () => string): LinkHighlightController {
  const entries = new Set<Entry>();
  let rafId = 0;
  let disposed = false;

  const drop = (e: Entry) => {
    entries.delete(e);
    e.decoration.dispose();
    e.marker.dispose();
  };
  const clear = () => entries.forEach(drop);

  const update = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (disposed) return;
    if (!highlighted(term)) return clear();
    const buf = term.buffer.active;
    const top = buf.viewportY;
    const bottom = top + term.rows;
    const byLine = new Map<number, Entry[]>();
    for (const e of entries) {
      const y = e.marker.line;
      if (e.marker.isDisposed || y < top - term.rows || y >= bottom + term.rows) drop(e);
      else byLine.set(y, [...(byLine.get(y) ?? []), e]);
    }
    let fg: string | undefined;
    // Rescans every visible row per pass (one regex pass per row); cache per line if profiles show the cost.
    for (let y = top; y < bottom; y++) {
      const line = buf.getLine(y);
      const want = line
        ? findTerminalLinks(line.translateToString(true))
            .filter((l) => l.kind === "url")
            .map((l) => linkCells(line, l))
            .filter((c) => c.end > c.start)
        : [];
      const have = byLine.get(y) ?? [];
      if (have.length === want.length && have.every((e, i) => e.start === want[i]!.start && e.end === want[i]!.end))
        continue;
      have.forEach(drop);
      for (const { start, end } of want) {
        const marker = term.registerMarker(y - (buf.baseY + buf.cursorY));
        if (!marker) continue;
        fg ??= color();
        const decoration = term.registerDecoration({ marker, x: start, width: end - start, foregroundColor: fg });
        if (!decoration) {
          marker.dispose();
          continue;
        }
        decoration.onRender((el) => el.classList.add(LINK_DECORATION_CLASS));
        entries.add({ marker, decoration, start, end });
      }
    }
  };

  const schedule = () => {
    if (!rafId && !disposed) rafId = requestAnimationFrame(update);
  };
  const subs = [term.onRender(schedule), term.onScroll(schedule), term.buffer.onBufferChange(schedule)];

  return {
    refresh() {
      clear();
      schedule();
    },
    update,
    dispose() {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      subs.forEach((s) => s.dispose());
      clear();
    },
  };
}
