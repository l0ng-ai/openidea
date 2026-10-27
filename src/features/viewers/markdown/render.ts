/**
 * Markdown → sanitized HTML for the preview. Every top-level block is wrapped
 * in an element carrying its 0-based source line (`data-line`) for scroll
 * sync; images keep their source in `data-src` and are loaded by the preview
 * (local files through the backend, as the CSP blocks file URLs). Mermaid
 * blocks become `[data-mermaid]` placeholders, drawn by `./mermaid`.
 */
import { Marked, type Token, type TokensList } from "marked";
import DOMPurify from "dompurify";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      if (lang?.trim().split(/\s+/)[0]?.toLowerCase() !== "mermaid") return false;
      return `<div data-mermaid=""><pre><code class="language-mermaid">${escapeHtml(text)}</code></pre></div>\n`;
    },
  },
});

// Own instance: hooks must not leak into the hover / documentation renderer.
let purifier: ReturnType<typeof DOMPurify> | null = null;

function purify(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src");
      node.removeAttribute("src");
      if (src) node.setAttribute("data-src", src);
    }
    if (node.tagName === "A" && node.getAttribute("href")) node.setAttribute("rel", "noopener noreferrer");
  });
  purifier = p;
  return p;
}

/**
 * Heading ids carry GitHub's prefix: bare ids like `title` would clobber
 * `document` properties, so the sanitizer drops them.
 */
export const ANCHOR_PREFIX = "user-content-";

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces → dashes. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const countLines = (s: string) => {
  let n = 0;
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) n++;
  return n;
};

export function renderMarkdown(text: string): string {
  const tokens = marked.lexer(text);
  const slugs = new Map<string, number>();
  let line = 0;
  let html = "";
  for (const token of tokens) {
    const start = line;
    line += countLines(token.raw);
    if (token.type === "space") continue;
    const list = Object.assign([token], { links: tokens.links }) as TokensList;
    let body = marked.parser(list);
    if (token.type === "heading") {
      const base = slugify((token as Token & { text: string }).text);
      const n = slugs.get(base) ?? 0;
      slugs.set(base, n + 1);
      body = body.replace(/^<h(\d)>/, `<h$1 id="${ANCHOR_PREFIX}${n ? `${base}-${n}` : base}">`);
    }
    html += `<div data-line="${start}">${body}</div>`;
  }
  return purify().sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["data-src", "data-line"] });
}

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string; anchor?: string; line?: number };

/** Directory of `file` (forward slashes). */
const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));

/** Joins `rel` onto `dir`, resolving `.` / `..`. Absolute `rel` (leading `/`) is kept. */
export function joinPath(dir: string, rel: string): string {
  const parts = (rel.startsWith("/") ? rel : `${dir}/${rel}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      if (out.length > 1) out.pop();
    } else if (p !== "." && (p !== "" || out.length === 0)) out.push(p);
  }
  return out.join("/") || "/";
}

/** Where a link in the Markdown file `file` points. */
export function resolveLink(file: string, href: string): LinkTarget | null {
  const h = href.trim();
  if (!h) return null;
  if (/^(https?|mailto):/i.test(h)) return { kind: "external", url: h };
  if (h.startsWith("#")) return { kind: "anchor", id: decodeURIComponent(h.slice(1)) };
  let rest = h;
  if (/^file:\/\//i.test(rest)) rest = rest.replace(/^file:\/\//i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) return null;
  const hash = rest.indexOf("#");
  const fragment = hash >= 0 ? decodeURIComponent(rest.slice(hash + 1)) : undefined;
  const pathPart = decodeURIComponent((hash >= 0 ? rest.slice(0, hash) : rest).replace(/\?.*$/, ""));
  const path = pathPart ? joinPath(dirOf(file), pathPart) : file;
  const lineMatch = fragment ? /^L(\d+)/.exec(fragment) : null;
  if (lineMatch) return { kind: "file", path, line: Math.max(0, Number(lineMatch[1]) - 1) };
  return { kind: "file", path, ...(fragment ? { anchor: fragment } : {}) };
}

/**
 * Preview scroll offset that shows source line `line` at the top: interpolates
 * between the blocks around it (`blocks` sorted by line, with their offsets).
 */
export function previewOffsetForLine(
  blocks: ReadonlyArray<{ line: number; top: number }>,
  line: number,
  end: number,
): number {
  if (!blocks.length) return 0;
  let i = 0;
  while (i + 1 < blocks.length && blocks[i + 1]!.line <= line) i++;
  const a = blocks[i]!;
  if (line <= a.line) return a.top;
  const b = blocks[i + 1];
  const nextLine = b?.line ?? a.line + 1;
  const nextTop = b?.top ?? end;
  const t = Math.min(1, (line - a.line) / Math.max(1, nextLine - a.line));
  return a.top + t * (nextTop - a.top);
}
