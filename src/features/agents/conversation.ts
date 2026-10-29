/** Reading an agent conversation: quoting, file links, turn times and finding text. */

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
  if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  const match = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+))?$/.exec(decoded);
  if (!match?.[1] || [...decoded].some((char) => char.charCodeAt(0) < 32)) return null;
  const path = match[1].startsWith("/") ? match[1] : `${cwd.replace(/\/$/, "")}/${match[1]}`;
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

/** DOM ranges of `query` in the text under `root` (matches within one text node). */
export function findRanges(root: Node, query: string): Range[] {
  const out: Range[] = [];
  if (!query) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
