/**
 * Paints an inline mark's background capped at `1lh` so a font taller than the line height
 * does not bleed into the rows above and below. When the inline box is shorter than `1lh`,
 * its own border box clips the gradient. Safari before 16.4 has no `lh` and drops the
 * shorthand, keeping the plain colour before it.
 */
export function inlineBackground(color: string) {
  return {
    backgroundColor: color,
    background: `linear-gradient(${color}, ${color}) center / 100% 1lh no-repeat`,
    WebkitBoxDecorationBreak: "clone",
    boxDecorationBreak: "clone",
  };
}

/** Fallback style for an inline mark with a 1px frame (`inlineFramedModern` caps it at `1lh`). */
export function inlineFramedFallback(fill: string, frame: string) {
  return {
    backgroundColor: fill,
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
    background: [
      `linear-gradient(to bottom, ${frame} 0 1px, transparent 1px calc(100% - 1px), ${frame} calc(100% - 1px) 100%) center / 100% min(100%, 1lh) no-repeat`,
      `linear-gradient(to right, ${frame} 0 1px, transparent 1px calc(100% - 1px), ${frame} calc(100% - 1px) 100%) center / 100% min(100%, 1lh) no-repeat`,
      `linear-gradient(${fill}, ${fill}) center / calc(100% - 2px) calc(min(100%, 1lh) - 2px) no-repeat`,
    ].join(", "),
  };
}
