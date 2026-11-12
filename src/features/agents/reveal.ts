/**
 * Paced reveal of a streaming reply. Chunks arrive in lumps (one flush per 40 ms, holding
 * whatever the model produced meanwhile); painting each as it lands makes the lumps show.
 * Arrival moves the target instead, and each frame reveals a share of the backlog, so a
 * burst catches up faster rather than jumping. The store keeps the whole text: only what
 * is painted is paced.
 */
import { useEffect, useState } from "react";

/** The backlog is drained over this long. Longer reads smoother but trails the model. */
export const REVEAL_HORIZON_MS = 150;
/** A frame stalled longer than this (a background tab) counts as this long. */
const MAX_FRAME_MS = 250;
/**
 * Commits at most at 60 Hz: a 120 Hz display would otherwise re-render the reply's Markdown
 * twice as often for no visible gain. The slack absorbs frame jitter on a 60 Hz display.
 */
const FRAME_MS = 1000 / 60 - 2;

/** Characters to reveal in a frame `elapsed` ms after the last, at least one while behind. */
export function revealStep(backlog: number, elapsed: number, horizon = REVEAL_HORIZON_MS): number {
  if (backlog <= 0) return 0;
  const ms = Math.min(Math.max(elapsed, 0), MAX_FRAME_MS);
  if (ms >= horizon) return backlog;
  return Math.min(backlog, Math.max(1, Math.ceil((backlog * ms) / horizon)));
}

const graphemes =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * `count` pulled back to the start of the grapheme it falls in, so a cluster (an emoji with
 * its joiners or skin tone, a flag, a letter with its combining marks) never paints in parts.
 * Only the painted end moves: the count still advances, so a long cluster can't stall.
 */
export function revealBoundary(text: string, count: number): number {
  if (count <= 0 || count >= text.length) return Math.max(0, Math.min(count, text.length));
  if (graphemes) return graphemes.segment(text).containing(count)?.index ?? count;
  const c = text.charCodeAt(count - 1);
  return c >= 0xd800 && c <= 0xdbff ? count - 1 : count;
}

/**
 * `text` without a trailing fragment that waits on the rest of its cluster: a chunk can end
 * mid-cluster. A lone high surrogate, a trailing zero-width joiner, an unpaired regional
 * indicator (half a flag).
 */
export function withoutBrokenTail(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  if ((last >= 0xd800 && last <= 0xdbff) || last === 0x200d) return text.slice(0, -1);
  let flags = 0;
  for (let i = text.length; i >= 2; i -= 2) {
    const cp = text.codePointAt(i - 2)!;
    if (cp < 0x1f1e6 || cp > 0x1f1ff) break;
    flags++;
  }
  return flags % 2 === 1 ? text.slice(0, -2) : text;
}

/**
 * The part of `text` to paint. While `live`, appended text is revealed at a pace; a text
 * that isn't the painted one continued (another message, an edit), or one that stops
 * being live, is shown whole at once.
 */
export function useRevealedText(text: string, live: boolean): string {
  const [state, setState] = useState({ text, count: text.length });
  let count = state.count;
  if (state.text !== text || (!live && count !== text.length)) {
    count = live && text.startsWith(state.text.slice(0, count)) ? Math.min(count, text.length) : text.length;
    setState({ text, count });
  }
  const behind = count < text.length;
  useEffect(() => {
    if (!behind) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      frame = requestAnimationFrame(tick);
      const elapsed = now - last;
      if (elapsed < FRAME_MS) return;
      last = now;
      setState((s) => ({ ...s, count: s.count + revealStep(s.text.length - s.count, elapsed) }));
    });
    return () => cancelAnimationFrame(frame);
  }, [behind]);
  if (behind) return text.slice(0, revealBoundary(text, count));
  return live ? withoutBrokenTail(text) : text;
}
