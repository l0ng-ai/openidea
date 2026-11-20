/**
 * LaTeX math support for Markdown (`marked` + `DOMPurify` + KaTeX).
 *
 * `mathExtension()` tokenizes `$$...$$`, `$...$`, `\[...\]`, `\(...\)`, and
 * ```` ```math ```` blocks into sanitized-safe `<div|span data-math="display|inline">`
 * placeholders, which survive `DOMPurify` (with `data-math` allowed) and are
 * rendered synchronously into KaTeX DOM by `renderMath()` right after sanitization.
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import "./markdownMath.css";
import type { MarkedExtension, Tokens } from "marked";

interface MathToken extends Tokens.Generic {
  type: "blockMath" | "inlineMath";
  raw: string;
  text: string;
  display: boolean;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function mathPlaceholder(tex: string, display: boolean, block = display): string {
  const tag = block ? "div" : "span";
  const mode = display ? "display" : "inline";
  return `<${tag} data-math="${mode}">${escapeHtml(tex)}</${tag}>`;
}

/** Finds the closing `delim` (`$$`, `\)`, or `\]`) skipping `\` escapes. Returns content end index or -1. */
function findClosingDelimiter(src: string, from: number, delim: string): number {
  for (let i = from; i < src.length; i++) {
    if (src.startsWith(delim, i)) return i;
    if (src[i] === "\\") {
      i++;
      continue;
    }
  }
  return -1;
}

// The first backtick run of the opening length ends the code span.
const PROTECTED_INLINE_DOLLAR = /^\$(?<ticks>`+)(?!`)(?<tex>(?:[^`\r\n]|(?!\k<ticks>(?!`))`+(?!`))+)\k<ticks>\$/;
// Marked masks code spans as `[aaa]` before calling emStrongMask
const MASKED_PROTECTED_INLINE_DOLLAR = /^\$\[(?<tex>a+)\]\$/;

/**
 * Matches inline `$...$` from index 0 using Pandoc-style guards so currency
 * like `$5 and $10` or `$5-$10` stays plain text while `$x$`, `设$x=1$`, etc. match.
 */
function matchInlineDollar(src: string, protectedDollar: RegExp): { end: number; text: string } | null {
  if (src[0] !== "$" || src[1] === "$" || !src[1] || /\s/.test(src[1])) return null;
  for (let i = 1; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "\n" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) {
      return null;
    }
    if (ch === "$") {
      if (protectedDollar.test(src.slice(i))) return null;
      if (i <= 1 || /\s/.test(src[i - 1]!)) continue;
      const next = src[i + 1] ?? "";
      if (next === "$" || /\d/.test(next)) return null;
      const text = src.slice(1, i);
      if (!text.trim()) return null;
      return { end: i + 1, text };
    }
  }
  return null;
}

/** Matches inline `$$...$$`, `$...$`, `\(...\)`, or `\[...\]` starting at index 0 of `src`. */
function matchInlineMath(
  src: string,
  protectedDollar = PROTECTED_INLINE_DOLLAR,
): { raw: string; text: string; display: boolean } | null {
  if (src.startsWith("$$")) {
    const close = findClosingDelimiter(src, 2, "$$");
    if (close > 2) {
      const text = src.slice(2, close);
      if (text.trim()) return { raw: src.slice(0, close + 2), text, display: true };
    }
    return null;
  }
  if (src[0] === "$") {
    const match = protectedDollar.exec(src);
    if (match) {
      const text = match.groups!.tex!;
      return text.trim() ? { raw: match[0], text, display: false } : null;
    }
    if (src[1] === "`") return null;
    const m = matchInlineDollar(src, protectedDollar);
    return m ? { raw: src.slice(0, m.end), text: m.text, display: false } : null;
  }
  if (src.startsWith("\\(")) {
    const close = findClosingDelimiter(src, 2, "\\)");
    if (close > 2) {
      const text = src.slice(2, close);
      if (text.trim()) return { raw: src.slice(0, close + 2), text, display: false };
    }
    return null;
  }
  if (src.startsWith("\\[")) {
    const close = findClosingDelimiter(src, 2, "\\]");
    if (close > 2 && src[close + 2] !== "(") {
      const text = src.slice(2, close);
      if (text.trim()) return { raw: src.slice(0, close + 2), text, display: true };
    }
    return null;
  }
  return null;
}

const BLOCK_DOLLAR_MULTI = /^ {0,3}\$\$[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\$\$[ \t]*(?:\r?\n+|$)/;
const BLOCK_DOLLAR_SINGLE = /^ {0,3}\$\$((?:\\[\s\S]|[^$\n]|\$(?!\$))+?)\$\$[ \t]*(?:\r?\n+|$)/;
const BLOCK_BRACKET_MULTI = /^ {0,3}\\\[[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\\\][ \t]*(?:\r?\n+|$)/;
const BLOCK_BRACKET_SINGLE = /^ {0,3}\\\[((?:\\[\s\S]|[^\\\n]|\\(?!\]))+?)\\\][ \t]*(?:\r?\n+|$)/;

function matchBlockMath(src: string): { raw: string; text: string } | null {
  for (const re of [BLOCK_DOLLAR_MULTI, BLOCK_DOLLAR_SINGLE, BLOCK_BRACKET_MULTI, BLOCK_BRACKET_SINGLE]) {
    const m = re.exec(src);
    if (m && m[1]!.trim()) return { raw: m[0], text: m[1]! };
  }
  return null;
}

/** Masks math spans with `a`s (preserving newlines) so `*` and `_` inside math never trigger emphasis. */
function maskInlineMath(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\\" && src[i + 1] !== "(" && src[i + 1] !== "[") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (src[i] === "$" || (src[i] === "\\" && (src[i + 1] === "(" || src[i + 1] === "["))) {
      const m = matchInlineMath(src.slice(i), MASKED_PROTECTED_INLINE_DOLLAR);
      if (m) {
        out += m.raw.replace(/[^\r\n]/g, "a");
        i += m.raw.length;
        continue;
      }
    }
    out += src[i]!;
    i++;
  }
  return out;
}

export function mathExtension(): MarkedExtension {
  return {
    hooks: {
      emStrongMask(src) {
        return maskInlineMath(src);
      },
    },
    renderer: {
      code({ text, lang }) {
        if (lang?.trim().split(/\s+/)[0]?.toLowerCase() !== "math") return false;
        return `${mathPlaceholder(text, true, true)}\n`;
      },
    },
    extensions: [
      {
        name: "blockMath",
        level: "block",
        start(src) {
          const m = /\n {0,3}(?:\$\$|\\\[)/.exec(src);
          return m ? m.index : undefined;
        },
        tokenizer(src): MathToken | undefined {
          const m = matchBlockMath(src);
          if (!m) return undefined;
          return { type: "blockMath", raw: m.raw, text: m.text, display: true };
        },
        renderer(token) {
          const t = token as MathToken;
          return `${mathPlaceholder(t.text, true, true)}\n`;
        },
      },
      {
        name: "inlineMath",
        level: "inline",
        start(src) {
          for (let i = 0; i < src.length; i++) {
            const ch = src[i]!;
            if (ch === "\\") {
              const next = src[i + 1];
              if (next === "(" || next === "[") return i;
              i++;
              continue;
            }
            if (ch === "$") return i;
          }
          return undefined;
        },
        tokenizer(src): MathToken | undefined {
          const m = matchInlineMath(src);
          if (!m) return undefined;
          return { type: "inlineMath", raw: m.raw, text: m.text, display: m.display };
        },
        renderer(token) {
          const t = token as MathToken;
          return mathPlaceholder(t.text, t.display, false);
        },
      },
    ],
  };
}

/** Renders every `[data-math]` placeholder inside `root` synchronously using KaTeX. */
export function renderMath(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-math]").forEach((el) => {
    const mode = el.getAttribute("data-math");
    el.removeAttribute("data-math");
    if (mode !== "inline" && mode !== "display") return;
    const tex = (el.textContent ?? "").trim();
    if (!tex) return;
    katex.render(tex, el, {
      displayMode: mode === "display",
      throwOnError: false,
      strict: false,
      trust: false,
    });
  });
}
