/**
 * Vertical padding that grows an inline mark's box to the full row when the line height is
 * taller than the font: an inline box is only as tall as its font, and a background never
 * paints outside it. Inline padding changes neither the line box nor where CodeMirror places
 * a click (it picks the line by height first). A font taller than the line height makes the
 * value negative, which padding clamps to 0. Safari before 16.4 drops it (no `lh`).
 */
const FULL_ROW_PADDING = "calc((1lh - 1em) / 2)";

/** A background capped at `1lh` so a font taller than the line height does not bleed into the rows above and below. */
function cappedBackground(color: string) {
  return {
    background: `linear-gradient(${color}, ${color}) center no-repeat`,
    // Separate from `background` so Safari before 16.4 ignores only the unsupported `lh` and still paints the fill.
    backgroundSize: "100% 1lh",
    WebkitBoxDecorationBreak: "clone",
    boxDecorationBreak: "clone",
  };
}

/** Paints an inline mark's background over the full row height, as the selection is. */
export function inlineBackground(color: string) {
  return { ...cappedBackground(color), paddingBlock: FULL_ROW_PADDING };
}

// Semantic roles can override this colour on nested syntax tokens without repainting
// unrelated descendants (e.g. a selection). An unset colour produces no background image.
// Token spans stay at the font's height: they are on every token, not just marks.
export const inlineTokenBackground = cappedBackground("var(--openidea-token-bg)");

/** Fallback style for an inline mark with a 1px frame (`inlineFramedModern` caps it at `1lh`). */
export function inlineFramedFallback(fill: string, frame: string) {
  return {
    background: fill,
    outline: `1px solid ${frame}`,
    outlineOffset: "-1px",
    WebkitBoxDecorationBreak: "clone",
    boxDecorationBreak: "clone",
  };
}

/** `@supports (height: 1lh)` override for `inlineFramedFallback`: caps both fill and 1px frame at `1lh`. */
export function inlineFramedModern(fill: string, frame: string) {
  return {
    outline: "none",
    paddingBlock: FULL_ROW_PADDING,
    background: [
      `linear-gradient(to bottom, ${frame} 0 1px, transparent 1px calc(100% - 1px), ${frame} calc(100% - 1px) 100%) center / 100% min(100%, 1lh) no-repeat`,
      `linear-gradient(to right, ${frame} 0 1px, transparent 1px calc(100% - 1px), ${frame} calc(100% - 1px) 100%) center / 100% min(100%, 1lh) no-repeat`,
      `linear-gradient(${fill}, ${fill}) center / calc(100% - 2px) calc(min(100%, 1lh) - 2px) no-repeat`,
    ].join(", "),
  };
}
