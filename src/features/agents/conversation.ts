/** Reading an agent conversation: quoting, file and symbol links, turn times and finding text. */

import type { SymbolKind } from "@/platform/ipc";
import { opensOtherShare } from "@/platform/paths";

/** Display a structured async answer as the question and answer, keeping its wire ids out of the UI. */
export function userMessageText(text: string): string {
  const start = "<send_user_message_question_reply>";
  const end = "</send_user_message_question_reply>";
  if (!text.startsWith(start) || !text.endsWith(end)) return text;
  try {
    const replies: unknown = JSON.parse(text.slice(start.length, -end.length));
    if (
      !Array.isArray(replies) ||
      !replies.length ||
      !replies.every(
        (reply) =>
          reply &&
          typeof reply.questionItemId === "string" &&
          typeof reply.question === "string" &&
          typeof reply.answer === "string",
      )
    )
      return text;
    return replies.map((reply) => `${reply.question}\n${reply.answer}`).join("\n\n");
  } catch {
    return text;
  }
}

/** `text` as a Markdown quote for the composer, followed by an empty line to type in. */
export function quoteText(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return `${lines.map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** Appends a quote to a draft, on its own paragraph. */
export function withQuote(draft: string, text: string): string {
  if (!draft.trim()) return quoteText(text);
  return `${draft.replace(/\s+$/, "")}\n\n${quoteText(text)}`;
}

export interface PathLink {
  /** Absolute path. */
  path: string;
  /** 0-based line and column, when the text names them. */
  line?: number;
  col?: number;
}

const PATH = /^(?:\.\/)?([\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]*)(?::(\d+)(?::(\d+))?|#L(\d+))?$/;

/** Explicit Markdown links can also name files with spaces or non-ASCII names. */
export function fileHref(href: string, cwd: string): PathLink | null {
  if (!href || href.startsWith("#")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  decoded = decoded.replace(/^\/(?=[a-z]:[\\/])/i, "");
  const windows = /^[a-z]:[\\/]/i.test(decoded);
  if (!windows && /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
  const match = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+))?$/.exec(decoded);
  if (!match?.[1] || [...decoded].some((char) => char.charCodeAt(0) < 32)) return null;
  const path = windows
    ? match[1].replace(/\\/g, "/")
    : match[1].startsWith("/")
      ? match[1]
      : `${cwd.replace(/\/$/, "")}/${match[1]}`;
  if (opensOtherShare(path, match[1], cwd)) return null;
  const link: PathLink = { path };
  const line = match[2] ?? match[4];
  if (line) link.line = Math.max(0, Number(line) - 1);
  if (match[3]) link.col = Math.max(0, Number(match[3]) - 1);
  return link;
}

/**
 * The file an inline code span names (`src/lib.rs`, `src/main.rs:12`, `a/b.ts:3:5`,
 * `/abs/x.py#L7`), resolved against `cwd`; null for text that isn't a file path
 * (`foo()`, `cargo test`, URLs, `1.5`, folders, words without an extension).
 */
export function pathLink(text: string, cwd: string): PathLink | null {
  const t = text.trim();
  if (!t || /\s|:\/\//.test(t)) return null;
  const absolute = t.startsWith("/");
  const m = PATH.exec(absolute ? t.slice(1) : t);
  if (!m) return null;
  const rel = m[1]!;
  const path = absolute ? `/${rel}` : `${cwd.replace(/\/$/, "")}/${rel}`;
  const line = m[2] ?? m[4];
  const out: PathLink = { path };
  if (line) out.line = Math.max(0, Number(line) - 1);
  if (m[3]) out.col = Math.max(0, Number(m[3]) - 1);
  return out;
}

/** A symbol an inline code span names: `name`, inside `container` or `file` when the text says so. */
export interface SymbolRef {
  name: string;
  container?: string;
  /** The tail of the defining file's path (`lib.rs`, `src/a.ts`). */
  file?: string;
  kinds: readonly SymbolKind[];
}

const IDENT = "[A-Za-z_$][\\w$]*";
const CALL = "(\\([^()]*\\))?";
const SYMBOL = new RegExp(`^(?:(${IDENT})(?:\\.|#|::))?(${IDENT})${CALL}$`);
const FILE_SYMBOL = new RegExp(`^((?:[\\w.@-]+\\/)*[\\w@-]+\\.[A-Za-z]\\w*)(?:#|::)(${IDENT})${CALL}$`);
const TYPE_KINDS: readonly SymbolKind[] = ["class", "interface", "struct", "enum", "trait", "typeAlias", "function"];
const CALLABLE_KINDS: readonly SymbolKind[] = ["function", "method", "constructor"];
const MEMBER_KINDS: readonly SymbolKind[] = [...CALLABLE_KINDS, "field", "property", "constant", "enumMember"];
const ANY_KINDS: readonly SymbolKind[] = [...new Set<SymbolKind>([...TYPE_KINDS, ...MEMBER_KINDS, "variable"])];
/** Capitalized keywords and literals that read like a type name. */
const LITERALS = new Set(["None", "True", "False", "Self", "Some", "Ok", "Err", "Null", "Nil", "NaN", "Infinity"]);

/**
 * The symbol inline code names (`FooView`, `load()`, `has_header`, `Config.load`,
 * `lib.rs::has_header`, `a.ts#load`); null for words, keywords, literals and anything
 * with spaces or shell syntax (`cargo test`, `true`, `None`, `x = 1`).
 */
export function symbolRef(text: string): SymbolRef | null {
  const trimmed = text.trim();
  const inFile = FILE_SYMBOL.exec(trimmed);
  if (inFile) return { name: inFile[2]!, file: inFile[1]!, kinds: ANY_KINDS };
  const match = SYMBOL.exec(trimmed);
  if (!match) return null;
  const [, container, name, call] = match;
  if (LITERALS.has(container ?? name!)) return null;
  if (container) return { name: name!, container, kinds: MEMBER_KINDS };
  if (call) return { name: name!, kinds: CALLABLE_KINDS };
  if (/^[A-Z]\w*[a-z]/.test(name!)) return { name: name!, kinds: TYPE_KINDS };
  if (/^[a-z]\w*[a-z\d][A-Z]/.test(name!) || /^[a-z][a-z\d]*(?:_[a-z\d]+)+$/.test(name!)) {
    return { name: name!, kinds: CALLABLE_KINDS };
  }
  return null;
}

/** `850ms`, `12s`, `1m 05s`, `2h 03m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Clock time of a message: `14:03` today, else with the date. */
export function formatSentAt(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** Start offsets of `query` in `text`, ignoring case; empty for an empty query. */
export function findAll(text: string, query: string): number[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

const SKIP_FIND_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "SVG", "BUTTON"]);

function isUnselectable(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.userSelect === "none" || style.webkitUserSelect === "none";
}

/**
 * DOM ranges of `query` in the selectable text under `root` (matches within one text node).
 * Skips `user-select: none` chrome (`.thought summary`, `.processSummary`, `.messageTime`,
 * `.role`…): WebKit's `CSS.highlights` skips unselectable text renderers and paints the
 * highlight over the next selectable text node instead.
 */
export function findRanges(root: Node, query: string): Range[] {
  const out: Range[] = [];
  if (!query) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.tagName.toUpperCase();
        if (SKIP_FIND_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        if (tag === "PRE" && el.parentElement?.getAttribute("data-mermaid-state") === "ok")
          return NodeFilter.FILTER_REJECT;
        if (isUnselectable(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const at of findAll(node.textContent ?? "", query)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      out.push(range);
    }
  }
  return out;
}

/**
 * True when `range` is rendered on screen and not inside a collapsed `<details>` or
 * `user-select: none` subtree. WebKit hides closed `<details>` bodies with
 * `content-visibility: hidden` (where `getClientRects()` stays non-empty once opened)
 * and forwards unrendered or unselectable `CSS.highlights` ranges onto adjacent rows.
 */
export function isFindRangeShown(range: Range, root: Node): boolean {
  for (let el = range.startContainer.parentElement; el && el !== root; el = el.parentElement) {
    if (isUnselectable(el)) return false;
    if (el instanceof HTMLDetailsElement && !el.open) {
      const summary = el.querySelector(":scope > summary");
      if (!summary?.contains(range.startContainer)) return false;
    }
  }
  return range.getClientRects().length > 0;
}
