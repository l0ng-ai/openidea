/**
 * Markdown → sanitized HTML for the preview. Every top-level block (or run of
 * blocks inside one HTML container) is wrapped in an element carrying its
 * 0-based source line (`data-line`) for scroll sync; images keep their source in `data-src` and are loaded by the preview
 * (local files through the backend, as the CSP blocks file URLs). Mermaid
 * blocks become `[data-mermaid]` placeholders, drawn by `./mermaid`. YAML front matter is shown
 * as a table of its top-level fields.
 */
import { Marked, type Token, type TokensList } from "marked";
import DOMPurify from "dompurify";
import { opensOtherShare } from "@/platform/paths";

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

/** Whether the webview would read `value` as an address on another host: it drops blanks and takes `\` for `/`. */
const namesHost = (value: string) =>
  /^(https?:|[\\/]{2})/i.test([...value].filter((c) => c.charCodeAt(0) > 32).join(""));

function purify(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  // The preview loads nothing from other hosts. Only a link, opened on a click, names one;
  // an image keeps its source for the preview to refuse.
  p.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "alt" || data.attrName === "title") return;
    if (data.attrName === "href" && node.tagName === "A") return;
    if (data.attrName === "src" && node.tagName === "IMG") return;
    if (namesHost(data.attrValue)) data.keepAttr = false;
  });
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

/** The YAML front matter at the start of `text`: its top-level fields and how many lines it spans. */
export function frontMatter(text: string): { fields: [string, string][]; lines: number } | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fields: [string, string][] = [];
  for (const raw of m[1]!.split(/\r?\n/)) {
    const field = /^([^\s#:-][^:]*?):(?:[ \t]+(.*))?$/.exec(raw);
    if (field) fields.push([field[1]!.trim(), (field[2] ?? "").trim()]);
    else if (raw.trim() && !raw.trimStart().startsWith("#")) {
      // A nested mapping or a list belongs to the field above it; anything else isn't front matter.
      const last = fields.at(-1);
      if (!last || !/^[\s-]/.test(raw)) return null;
      last[1] = last[1] ? `${last[1]}\n${raw}` : raw;
    }
  }
  return fields.length ? { fields, lines: countLines(m[0]) + (m[0].endsWith("\n") ? 0 : 1) } : null;
}

/** `text` without the indentation all its lines share. */
function dedent(text: string): string {
  const lines = text.split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

function frontMatterTable(fields: readonly [string, string][]): string {
  const rows = fields.map(([key, value]) => {
    // Nested values keep their YAML layout.
    const shown = value.includes("\n")
      ? `<pre>${escapeHtml(dedent(value.replace(/^\n+/, "")))}</pre>`
      : escapeHtml(value);
    return `<tr><th>${escapeHtml(key)}</th><td>${shown}</td></tr>`;
  });
  return `<table data-front-matter=""><tbody>${rows.join("")}</tbody></table>`;
}

// Containers whose open and close tags may sit in separate HTML blocks with Markdown between them.
const CONTAINER_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "div",
  "dl",
  "figure",
  "footer",
  "header",
  "main",
  "nav",
  "ol",
  "section",
  "table",
  "ul",
]);
const TAG = /<(\/?)([a-zA-Z][\w-]*)(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g;

/** Applies the container tags an HTML block opens and closes to `open`, the stack of unclosed ones. */
function trackContainers(raw: string, open: string[]) {
  for (const [, closing, name, selfClosing] of raw.replace(/<!--[\s\S]*?(?:-->|$)/g, "").matchAll(TAG)) {
    const tag = name!.toLowerCase();
    if (!CONTAINER_TAGS.has(tag) || selfClosing) continue;
    if (!closing) open.push(tag);
    else if (open.includes(tag)) open.length = open.lastIndexOf(tag);
  }
}

export function renderMarkdown(text: string): string {
  const front = frontMatter(text);
  const body = front ? text.split("\n").slice(front.lines).join("\n") : text;
  const tokens = marked.lexer(body);
  const slugs = new Map<string, number>();
  let line = front?.lines ?? 0;
  let html = front ? `<div data-line="0">${frontMatterTable(front.fields)}</div>` : "";
  // Blocks inside an HTML container left open (`<details>`, `<div>`…) share its wrapper up to
  // the close: a wrapper per block would end the container early and spill its content out.
  const open: string[] = [];
  let group: { line: number; html: string } | null = null;
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
    group ??= { line: start, html: "" };
    group.html += body;
    if (token.type === "html") trackContainers(token.raw, open);
    if (open.length) continue;
    html += `<div data-line="${group.line}">${group.html}</div>`;
    group = null;
  }
  if (group) html += `<div data-line="${group.line}">${group.html}</div>`;
  // The preview shares the IDE's document: a `<style>` in a file would restyle the whole IDE.
  return purify().sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["data-src", "data-line", "data-front-matter"],
    // `srcset` and `<source>` would pick an image past the one the preview loads.
    FORBID_TAGS: ["style", "form", "source"],
    FORBID_ATTR: ["style", "srcset"],
  });
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
  if (pathPart && opensOtherShare(path, pathPart, file)) return null;
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

/** Source line of the block at the top of a preview scrolled to `offset`: the first one if none is above it. */
export function previewLineAtOffset(blocks: ReadonlyArray<{ line: number; top: number }>, offset: number): number {
  let line = blocks[0]?.line ?? 0;
  for (const b of blocks) {
    if (b.top > offset + 1) break;
    line = b.line;
  }
  return line;
}
