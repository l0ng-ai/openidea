/**
 * Width of console output in monospace columns. Virtualized consoles place their rows
 * absolutely, and such rows only widen the scroll area while they are mounted: without a
 * fixed content width the horizontal scrollbar comes and goes as long lines scroll in and
 * out of view, and where scrollbars take layout space (Windows) that change of height
 * scrolls again, so the view flickers at the bottom.
 */

/** Wide characters take two columns: CJK, Hangul, fullwidth forms and emoji. */
function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** Columns of the widest line in `text`; a tab moves to the next multiple of `tabSize`. */
export function textColumns(text: string, tabSize: number): number {
  let col = 0;
  let max = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 10) {
      max = Math.max(max, col);
      col = 0;
    } else if (c === 9) col += tabSize - (col % tabSize);
    else if (c >= 32) col += isWide(c) ? 2 : 1;
  }
  return Math.max(max, col);
}

/**
 * The widest of a console's lines, measured incrementally. The lines are append-only
 * (front lines may be dropped) and the last one may still grow, so each call measures
 * only what came after the last line seen before; anything else (a cleared console)
 * measures everything again.
 */
export class WidestColumns {
  private last: object | null = null;
  private max = 0;

  constructor(private readonly tabSize = 4) {}

  measure(lines: readonly { text: string }[]): number {
    let from = this.last ? lines.lastIndexOf(this.last as { text: string }) : -1;
    if (from < 0) {
      this.max = 0;
      from = 0;
    }
    for (let i = from; i < lines.length; i++) this.max = Math.max(this.max, textColumns(lines[i]!.text, this.tabSize));
    this.last = lines.at(-1) ?? null;
    return this.max;
  }
}
