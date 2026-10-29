/**
 * ANSI escape handling for process output (Run and Debug consoles): one stateful
 * parser per stream turns text with SGR colours into styled spans, keeping a style
 * across chunks and dropping the other escapes. Colours are the `--ansi-*` palette
 * (`ansi.module.css`).
 */
/* eslint-disable no-control-regex -- escape-sequence parsing matches control characters by design */
import type { CSSProperties } from "react";
import Anser from "anser";

export interface SpanStyle {
  /** CSS colour (`var(--ansi-red)`, `rgb(…)`). */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface Span extends SpanStyle {
  text: string;
}

const NAMED = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** xterm 256-colour palette entry (16–255) as `rgb(…)`. */
export function paletteColor(n: number): string {
  if (n < 16) {
    const bright = n >= 8;
    return `var(--ansi-${bright ? "bright-" : ""}${NAMED[n % 8]})`;
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]}, ${steps[Math.floor(i / 6) % 6]}, ${steps[i % 6]})`;
}

function cssColor(cls: string | null, truecolor: string | null): string | undefined {
  if (!cls) return undefined;
  if (cls === "ansi-truecolor") return truecolor ? `rgb(${truecolor})` : undefined;
  const palette = /^ansi-palette-(\d+)$/.exec(cls);
  if (palette) return paletteColor(Number(palette[1]));
  if (cls.startsWith("ansi-")) return `var(--${cls})`;
  return undefined;
}

export function sameStyle(a: SpanStyle, b: SpanStyle) {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike
  );
}

/** Inline style of a span (none for plain text). */
export function spanStyle(s: SpanStyle): CSSProperties | undefined {
  if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.strike) return undefined;
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  return {
    color: s.fg,
    background: s.bg,
    fontWeight: s.bold ? "var(--fw-code-bold, 700)" : undefined,
    opacity: s.dim ? 0.6 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: deco || undefined,
  };
}

// OSC (…BEL or …ST), and escape sequences other than CSI.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const NON_CSI_ESC_RE = /\x1b(?:[()][0-9A-Za-z]|[=>78DEHMNOZc])/g;
// CSI that isn't SGR: erase-line becomes a carriage return, everything else is dropped.
const CSI_RE = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/g;
// An escape sequence cut off at the end of a chunk.
const INCOMPLETE_RE = /\x1b(?:\[[0-9;?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;

function entryStyle(e: Anser.AnserJsonEntry): SpanStyle {
  const decorations = e.decorations ?? [];
  const style: SpanStyle = {};
  let fg = cssColor(e.fg, e.fg_truecolor);
  let bg = cssColor(e.bg, e.bg_truecolor);
  if ((e as { isInverted?: boolean }).isInverted) {
    [fg, bg] = [bg ?? "var(--bg-app)", fg ?? "var(--fg)"];
  }
  if (fg) style.fg = fg;
  if (bg) style.bg = bg;
  if (decorations.includes("bold")) style.bold = true;
  if (decorations.includes("dim")) style.dim = true;
  if (decorations.includes("italic")) style.italic = true;
  if (decorations.includes("underline")) style.underline = true;
  if (decorations.includes("strikethrough")) style.strike = true;
  return style;
}

/** The ANSI state of one output stream. */
export class AnsiStream {
  private anser = new Anser();
  private carry = "";
  /** Style in effect at the end of the previous call (anser only carries it into escaped chunks). */
  private carryStyle: SpanStyle = {};

  /** Normalises escapes; returns text whose only escapes are SGR (`ESC[…m`). */
  clean(text: string): string {
    let s = this.carry + text;
    this.carry = "";
    const cut = INCOMPLETE_RE.exec(s);
    if (cut && cut[0].length > 0) {
      this.carry = cut[0];
      s = s.slice(0, cut.index);
    }
    return s
      .replace(OSC_RE, "")
      .replace(NON_CSI_ESC_RE, "")
      .replace(CSI_RE, (all, params: string, _i: string, final: string) => {
        if (final === "m") return all;
        if (final === "K" && (params === "2" || params === "1")) return "\r";
        if (final === "G" && (params === "" || params === "1" || params === "0")) return "\r";
        return "";
      })
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
  }

  /** Spans of text already passed through [`clean`]. */
  spans(text: string): Span[] {
    const out: Span[] = [];
    const entries = this.anser.ansiToJson(text, { json: true, use_classes: true });
    entries.forEach((e, i) => {
      // Entry 0 is the text before the first escape: it continues the previous style.
      const style = i === 0 ? this.carryStyle : entryStyle(e);
      if (i === entries.length - 1) this.carryStyle = style;
      if (e.content) out.push({ text: e.content, ...style });
    });
    return out;
  }

  /** [`clean`] then [`spans`], with `\r` dropped: for consoles that don't overwrite lines. */
  parse(text: string): Span[] {
    return this.spans(this.clean(text).replace(/\r(?=\n|$)/g, ""));
  }
}

/** Appends `spans` to `into`, merging a span into the previous one of the same style. */
export function appendSpans(into: Span[], spans: readonly Span[]): Span[] {
  const out = into.slice();
  for (const span of spans) {
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, span)) out[out.length - 1] = { ...prev, text: prev.text + span.text };
    else out.push(span);
  }
  return out;
}
