/**
 * Agent messages: Markdown → sanitized HTML (marked + DOMPurify). Fenced code is
 * highlighted and gets a Copy button; inline code naming a file of the task opens it.
 * Mermaid fences become `[data-mermaid]` placeholders drawn by the Markdown viewer's
 * shared renderer after each render; the block keeps a Copy button of its own, since
 * the drawn diagram hides the code block, and `onDiagramDrawn` lets the conversation
 * follow the end when a diagram draws after the last streamed chunk.
 */
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { highlightInto } from "@/editor/lsp/markdown";
import { iconNode } from "@/editor/lsp/iconMarkup";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { copyText } from "@/ui";
import { editorService } from "@/workbench/contributions";
import { hasMermaid, renderMermaidIn } from "@/features/viewers/markdown/mermaid";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import { fileHref, pathLink, type PathLink } from "./conversation";
import { loadImages, type MessageImages } from "./markdownImages";
import styles from "./Session.module.css";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      if (lang?.trim().split(/\s+/)[0]?.toLowerCase() !== "mermaid") return false;
      return `<div data-mermaid=""><pre><code class="language-mermaid">${escapeHtml(text)}</code></pre></div>\n`;
    },
  },
});

/** Rendered messages by text, least recently used first: reopening a conversation renders it again. */
const rendered = new Map<string, string>();
const RENDERED_MAX = 500;

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** Whether the webview would read `value` as an address on another host: it drops blanks and takes `\` for `/`. */
const namesHost = (value: string) =>
  /^(https?:|[\\/]{2})/i.test([...value].filter((c) => c.charCodeAt(0) > 32).join(""));

function purify(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  // A reply reaches another host only when the user asks: a link they click, an image `loadImages` holds.
  // `poster`, `background` and the `src` of other tags would fetch as soon as the reply renders.
  p.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "alt" || data.attrName === "title") return;
    if (data.attrName === "href" && node.tagName === "A") return;
    if (namesHost(data.attrValue)) data.keepAttr = false;
  });
  const sources = new WeakMap<Node, string>();
  // Preserve image-only file URLs without relaxing URI sanitizing for links or other tags.
  p.addHook("beforeSanitizeAttributes", (node) => {
    if (node.tagName !== "IMG") return;
    sources.set(node, node.getAttribute("src") ?? "");
    node.removeAttribute("src");
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    const src = sources.get(node);
    if (src) node.setAttribute("data-image-src", src);
  });
  purifier = p;
  return p;
}

/**
 * `text` cut into its top-level blocks (a paragraph, a list, a fence…), each with the
 * blank lines after it, so they join back into `text`. While a reply streams only its
 * last block changes: the others keep their rendering. Reference links reach across
 * blocks, and an HTML block can open in one token and close in another, so a text with
 * either stays whole. The blocks before the last of `previous` (this text's blocks
 * before it streamed on) have ended: when `text` still starts with them, only the rest
 * is cut again.
 */
export function markdownBlocks(text: string, previous: readonly string[] = []): string[] {
  let stable = 0;
  let offset = 0;
  while (stable < previous.length - 1 && text.startsWith(previous[stable]!, offset))
    offset += previous[stable++]!.length;
  if (stable) {
    const rest = lexBlocks(text.slice(offset));
    if (rest) return [...previous.slice(0, stable), ...rest];
  }
  return lexBlocks(text) ?? [text];
}

/** `text`'s blocks, or `null` when it has to render whole. */
function lexBlocks(text: string): string[] | null {
  const tokens = marked.lexer(text);
  if (Object.keys(tokens.links).length || tokens.some((t) => t.type === "html")) return null;
  const blocks: string[] = [];
  for (const t of tokens) {
    if (t.type === "space" && blocks.length) blocks[blocks.length - 1] += t.raw;
    else blocks.push(t.raw);
  }
  // The lexer can drop what it doesn't keep in a token (trailing whitespace); keep the text whole.
  return blocks.join("") === text ? blocks : null;
}

export function markdownHtml(text: string): string {
  let html = rendered.get(text);
  if (html === undefined) {
    html = renderHtml(text);
    if (rendered.size >= RENDERED_MAX) rendered.delete(rendered.keys().next().value!);
  } else rendered.delete(text);
  rendered.set(text, html);
  return html;
}

function renderHtml(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  // Replies can quote repository content. Styles would reach the whole IDE, and the click
  // handlers below trust `data-copy` / `data-path`, which only `enhance` may set.
  const root = purify().sanitize(html, {
    USE_PROFILES: { html: true },
    RETURN_DOM: true,
    FORBID_TAGS: ["style", "form", "source"],
    FORBID_ATTR: ["style", "srcset"],
    ALLOW_DATA_ATTR: false,
    // Only the mermaid placeholder written by the renderer above; data attributes
    // quoted in a reply stay out.
    ADD_ATTR: ["data-mermaid"],
  }) as HTMLElement;
  root.querySelectorAll("li").forEach(wrapLooseText);
  // WebKit cuts controls inside <pre> out of a text selection, even when transparent.
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.hasAttribute("data-mermaid")) return;
    const block = document.createElement("div");
    block.className = styles.codeBlock!;
    pre.replaceWith(block);
    block.appendChild(pre);
  });
  return root.innerHTML;
}

const BLOCK = new Set(["UL", "OL", "P", "PRE", "BLOCKQUOTE", "TABLE", "HR", "DIV", "H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Puts the text of an item that also holds a nested list (or other blocks) in its own
 * block. Otherwise WebKit paints a stray sliver of selection from the end of that text
 * to the right edge when a selection ends there.
 */
function wrapLooseText(li: Element) {
  const nodes = [...li.childNodes];
  if (!nodes.some((n) => BLOCK.has(n.nodeName))) return;
  let run: ChildNode[] = [];
  const flush = () => {
    if (run.some((n) => n.nodeType !== Node.TEXT_NODE || n.textContent!.trim())) {
      const div = li.ownerDocument.createElement("div");
      run[0]!.before(div);
      div.append(...run);
    }
    run = [];
  };
  for (const n of nodes) {
    if (BLOCK.has(n.nodeName)) flush();
    else run.push(n);
  }
  flush();
}

/** Whether a path names an existing file, per path (agents name the same files again and again). */
const existing = new Map<string, Promise<boolean>>();
function fileExists(path: string): Promise<boolean> {
  let known = existing.get(path);
  if (!known) {
    known = call(commands.fsProbe(path)).then(
      () => true,
      () => false,
    );
    existing.set(path, known);
  }
  return known;
}

export function openPathLink(link: PathLink) {
  const selection = link.line === undefined ? undefined : { line: link.line, col: link.col ?? 0 };
  void editorService().openFile(link.path, { selection, focus: true });
}

/** Highlighting, Copy buttons and file links over freshly rendered `root`. */
function enhance(root: HTMLElement, cwd: string, images: MessageImages): () => void {
  let alive = true;
  const disposeImages = loadImages(root, cwd, images);
  const copies: HTMLButtonElement[] = [];
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const pre = code.parentElement!;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
    const text = (code.textContent ?? "").replace(/\n+$/, "");
    code.textContent = text;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = styles.codeCopy!;
    const label = tx("Copy Code");
    copy.title = label;
    copy.setAttribute("aria-label", label);
    copy.appendChild(iconNode("copy", 14));
    copy.dataset.copy = text;
    const block = pre.parentElement!;
    block.appendChild(copy);
    copies.push(copy);
    if (!block.hasAttribute("data-mermaid")) void highlightInto(code, text, lang);
  });
  root.querySelectorAll<HTMLElement>("code").forEach((code) => {
    if (code.parentElement?.tagName === "PRE" || code.closest("a")) return;
    const link = pathLink(code.textContent ?? "", cwd);
    if (!link) return;
    void fileExists(link.path).then((exists) => {
      if (!alive || !exists) return;
      code.classList.add(styles.fileLink!);
      code.dataset.path = link.path;
      if (link.line !== undefined) code.dataset.line = String(link.line);
      if (link.col !== undefined) code.dataset.col = String(link.col);
      code.title = tx`Open ${link.path}`;
    });
  });
  return () => {
    alive = false;
    copies.forEach((copy) => copy.remove());
    disposeImages();
  };
}

interface PaintedBlock {
  source: string;
  nodes: ChildNode[];
  dispose: () => void;
}

/** Removes the painted blocks from `from` on. */
function clearBlocks(painted: PaintedBlock[], from: number) {
  for (const block of painted.splice(from)) {
    block.dispose();
    block.nodes.forEach((n) => n.remove());
  }
}

/**
 * Brings `root` to `sources`: blocks whose source is unchanged keep their nodes (and
 * whatever was drawn into them); the rest are rendered after them. The nodes go straight
 * into `root`, as a single rendering would put them, so styles and selections see one
 * message.
 */
function paintBlocks(
  root: HTMLElement,
  painted: PaintedBlock[],
  sources: string[],
  cwd: string,
  images: MessageImages,
) {
  let same = 0;
  while (same < painted.length && same < sources.length && painted[same]!.source === sources[same]) same++;
  clearBlocks(painted, same);
  sources.slice(same).forEach((source, i, rest) => {
    const holder = document.createElement("div");
    // A streaming reply changes its last block on every frame: kept, those would push
    // the finished blocks of other messages out of the cache.
    holder.innerHTML = i === rest.length - 1 && !rendered.has(source) ? renderHtml(source) : markdownHtml(source);
    const dispose = enhance(holder, cwd, images);
    const nodes = [...holder.childNodes];
    root.append(...nodes);
    painted.push({ source, nodes, dispose });
  });
}

export function Markdown({
  text,
  cwd,
  onDiagramDrawn,
}: {
  text: string;
  cwd: string;
  /** A diagram drew after the message rendered: the conversation may follow the end. */
  onDiagramDrawn?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const images = useRef<MessageImages>({ reads: new Map(), asked: new Set() });
  /** The blocks on screen, so a streamed chunk repaints only the blocks it changed. */
  const painted = useRef<PaintedBlock[]>([]);
  const paintedCwd = useRef(cwd);
  /** The last drawing of each mermaid block, stood in while a changed one renders. */
  const diagrams = useRef<Node[]>([]);
  // Diagrams are drawn in the active theme's colours: a theme change redraws them.
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (paintedCwd.current !== cwd) {
      clearBlocks(painted.current, 0);
      paintedCwd.current = cwd;
    }
    const sources = markdownBlocks(
      text,
      painted.current.map((b) => b.source),
    );
    paintBlocks(root, painted.current, sources, cwd, images.current);
  }, [text, cwd]);
  useLayoutEffect(() => {
    const blocks = painted.current;
    return () => clearBlocks(blocks, 0);
  }, []);
  // Mermaid diagrams: before paint, so cached ones don't flash their source. Only a
  // draw that lands after the render needs the follow — cached ones are in place by
  // the time the conversation's own render pass scrolls.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !hasMermaid(root)) return;
    const pass = renderMermaidIn(root, diagrams.current);
    let live = true;
    if (pass.async) void pass.done.then(() => live && onDiagramDrawn?.());
    return () => {
      live = false;
      pass.cancel();
    };
  }, [text, theme, onDiagramDrawn]);
  return (
    <div
      ref={ref}
      className={styles.markdown}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const copy = target.closest<HTMLElement>("button[data-copy]");
        if (copy) {
          void copyText(copy.dataset.copy ?? "");
          return;
        }
        const file = target.closest<HTMLElement>("code[data-path]");
        if (file && !window.getSelection()?.toString()) {
          const line = file.dataset.line === undefined ? undefined : Number(file.dataset.line);
          const col = file.dataset.col === undefined ? undefined : Number(file.dataset.col);
          openPathLink({ path: file.dataset.path!, line, col });
          return;
        }
        const a = target.closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (/^https?:/i.test(href)) void openExternalUrl(href);
        else {
          const link = fileHref(href, cwd);
          if (link) openPathLink(link);
        }
      }}
    />
  );
}
