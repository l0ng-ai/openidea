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

/** Characters to reveal in a frame `elapsed` ms after the last, at least one while behind. */
export function revealStep(backlog: number, elapsed: number, horizon = REVEAL_HORIZON_MS): number {
  if (backlog <= 0) return 0;
  const ms = Math.min(Math.max(elapsed, 0), MAX_FRAME_MS);
  if (ms >= horizon) return backlog;
  return Math.min(backlog, Math.max(1, Math.ceil((backlog * ms) / horizon)));
}

/** `count` moved past a lone UTF-16 high surrogate, so an emoji never paints half. */
function boundary(text: string, count: number): number {
  const c = text.charCodeAt(count - 1);
  return c >= 0xd800 && c <= 0xdbff ? Math.min(count + 1, text.length) : count;
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
      const elapsed = now - last;
      last = now;
      setState((s) => ({
        ...s,
        count: boundary(s.text, s.count + revealStep(s.text.length - s.count, elapsed)),
      }));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [behind]);
  return behind ? text.slice(0, count) : text;
}
