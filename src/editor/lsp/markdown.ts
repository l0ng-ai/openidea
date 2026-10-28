/**
 * Markdown (hover, documentation, signature docs) → sanitized DOM. Fenced
 * code blocks are highlighted with the matching Lezer grammar (falling back
 * to the editor's language), using `tok-*` classes styled in `theme.ts`.
 *
 * The Markdown parser (marked + DOMPurify, ~40 KB gzip) loads on first use and
 * is prefetched when the app goes idle; until then markup shows as plain text.
 */
import { useMemo, useSyncExternalStore } from "react";
import { LanguageDescription, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { Markup } from "@/bindings";
import { maybeEditorService } from "@/workbench/contributions";
import { isTauri } from "@/platform/ipc";
import { isVirtualUri } from "@/platform/virtualDocs";
import { selectableText } from "@/ui/selectableText";

type Parser = typeof import("./markdownParser");

let parser: Parser | null = null;
let loading: Promise<Parser> | null = null;
const readyListeners = new Set<() => void>();

export function loadMarkdown(): Promise<Parser> {
  return (loading ??= import("./markdownParser").then((m) => {
    parser = m;
    readyListeners.forEach((l) => l());
    return m;
  }));
}

/** Loads the parser once the app is idle, so the first hover does not wait for it. */
export function prefetchMarkdown() {
  const load = () => void loadMarkdown().catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(load, { timeout: 5000 });
  else setTimeout(load, 2000);
}

function subscribeReady(cb: () => void) {
  readyListeners.add(cb);
  if (!parser) void loadMarkdown().catch(() => {});
  return () => void readyListeners.delete(cb);
}

/** `markupToHtml` for React views: re-renders with the Markdown once the parser has loaded. */
export function useMarkupHtml(m: Markup): string {
  const ready = useSyncExternalStore(subscribeReady, () => parser !== null);
  const { kind, value } = m;
  return useMemo(() => (ready ? markupToHtml({ kind, value }) : plainHtml(value)), [ready, kind, value]);
}

function plainHtml(value: string): string {
  return `<p class="cm-lsp-plain">${escapeHtml(value)}</p>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sanitized HTML; plain text while the Markdown parser is still loading. */
export function markupToHtml(m: Markup): string {
  if (m.kind === "markdown" && parser) return parser.markdownToSafeHtml(m.value);
  if (m.kind === "markdown") void loadMarkdown().catch(() => {});
  return plainHtml(m.value);
}

export function isEmptyMarkup(m: Markup | null | undefined): boolean {
  return !m || !m.value.trim();
}

/**
 * The declaration line(s) of hover documentation, for the brief ⌘-hover info: the first fenced code block, else the first paragraph.
 */
export function declarationSummary(
  m: Markup,
  maxLines = 6,
): { code: string; language: string | null } | { text: string } | null {
  if (m.kind === "markdown") {
    const fence = /^\s*(```|~~~)[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)\n\s*\1/m.exec(m.value);
    if (fence && fence[3]!.trim()) {
      const lines = fence[3]!.replace(/\s+$/, "").split("\n");
      const code = lines.slice(0, maxLines).join("\n") + (lines.length > maxLines ? "\n…" : "");
      return { code, language: fence[2] || null };
    }
  }
  const para = m.value
    .trim()
    .split(/\n\s*\n/)[0]
    ?.trim();
  if (!para) return null;
  return { text: para.length > 200 ? `${para.slice(0, 199)}…` : para };
}

const langCache = new Map<string, LanguageDescription | null>();

function findLanguage(name: string): LanguageDescription | null {
  const key = name.toLowerCase();
  if (!langCache.has(key)) langCache.set(key, LanguageDescription.matchLanguageName(languages, key, true));
  return langCache.get(key) ?? null;
}

export function languageForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LanguageDescription.matchFilename(languages, name)?.name ?? null;
}

export interface CodeToken {
  from: number;
  to: number;
  /** Lezer `classHighlighter` classes (`tok-string` …). */
  cls: string;
}

/** Highlighted ranges of `text`; empty when the language is unknown or its grammar fails to load. */
export async function highlightTokens(text: string, language: string | null): Promise<CodeToken[]> {
  return (await codeHighlighter(text, language))?.(0, text.length) ?? [];
}

/**
 * Parses `text` once; the result gives the highlighted ranges (positions in
 * `text`) between `from` and `to`, so a line is coloured with the whole file
 * as context. Null when the language is unknown or its grammar fails to load.
 */
export async function codeHighlighter(
  text: string,
  language: string | null,
): Promise<((from: number, to: number) => CodeToken[]) | null> {
  const desc = language ? findLanguage(language) : null;
  if (!desc) return null;
  try {
    const support = desc.support ?? (await desc.load());
    const tree = await parseSliced(support.language.parser, text);
    return (from, to) => {
      const out: CodeToken[] = [];
      highlightTree(
        tree,
        classHighlighter,
        (a, b, cls) => {
          const s = Math.max(a, from);
          const e = Math.min(b, to);
          if (e > s) out.push({ from: s, to: e, cls });
        },
        from,
        to,
      );
      return out;
    };
  } catch {
    return null;
  }
}

/** Parse budget per task: a whole file (up to ~1s) yields to input and rendering in between. */
const PARSE_SLICE_MS = 8;

async function parseSliced(parser: Language["parser"], text: string): Promise<ReturnType<Language["parser"]["parse"]>> {
  const parse = parser.startParse(text);
  for (;;) {
    const start = performance.now();
    while (performance.now() - start < PARSE_SLICE_MS) {
      const tree = parse.advance();
      if (tree) return tree;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Replaces `el`'s text with highlighted spans (no-op when the language is unknown). */
export async function highlightInto(el: HTMLElement, text: string, language: string | null): Promise<void> {
  const tokens = await highlightTokens(text, language);
  if (!tokens.length) return;
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const t of tokens) {
    if (t.from > pos) frag.appendChild(document.createTextNode(text.slice(pos, t.from)));
    const span = document.createElement("span");
    span.className = t.cls;
    span.textContent = text.slice(t.from, t.to);
    frag.appendChild(span);
    pos = t.to;
  }
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  el.replaceChildren(frag);
}

function highlightBlocks(root: HTMLElement, fallback: string | null) {
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const cls = [...code.classList].find((c) => c.startsWith("language-"));
    const lang = cls ? cls.slice("language-".length) : fallback;
    const text = (code.textContent ?? "").replace(/\n+$/, "");
    code.textContent = text;
    void highlightInto(code, text, lang);
  });
}

/** A documentation link to a source position (`file://…#L12,5`, `jdt://…#L42`); null for web links. */
export function sourceLink(href: string): { path: string; line: number; col: number } | null {
  if (href.startsWith("file://")) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const m = /^#?L?(\d+)(?:[,:](\d+))?/.exec(url.hash.slice(1));
    return {
      path: decodeURIComponent(url.pathname),
      line: m ? Math.max(0, Number(m[1]) - 1) : 0,
      col: m?.[2] ? Math.max(0, Number(m[2]) - 1) : 0,
    };
  }
  if (isVirtualUri(href) && !/^https?:/i.test(href) && !/^mailto:/i.test(href)) {
    // Library class links (jdtls hover: `jdt://contents/…#L42`).
    const hash = href.indexOf("#");
    const m = hash >= 0 ? /^L?(\d+)/.exec(href.slice(hash + 1)) : null;
    return { path: hash >= 0 ? href.slice(0, hash) : href, line: m ? Math.max(0, Number(m[1]) - 1) : 0, col: 0 };
  }
  return null;
}

/** Opens a documentation link: source links in the editor, web links in the browser. */
export function openDocLink(href: string) {
  const target = sourceLink(href);
  if (target) {
    void maybeEditorService()?.openFile(target.path, {
      selection: { line: target.line, col: target.col },
      focus: true,
    });
  } else if (/^https?:\/\//.test(href) && isTauri()) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch(() => {});
  }
}

/** Handles a link click itself (true) or leaves it to `openDocLink` (false). */
export type DocLinkHandler = (href: string, e: MouseEvent) => boolean;

function linkClickHandler(onLink?: DocLinkHandler) {
  return (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (onLink?.(href, e)) return;
    openDocLink(href);
  };
}

/** Renders markup into a `.cm-lsp-markdown` element. */
export function renderMarkup(m: Markup, fallbackLanguage: string | null = null, onLink?: DocLinkHandler): HTMLElement {
  const dom = document.createElement("div");
  dom.className = `cm-lsp-markdown ${selectableText}`;
  dom.innerHTML = markupToHtml(m);
  highlightBlocks(dom, fallbackLanguage);
  if (m.kind === "markdown" && !parser) {
    void loadMarkdown()
      .then(() => {
        dom.innerHTML = markupToHtml(m);
        highlightBlocks(dom, fallbackLanguage);
      })
      .catch(() => {});
  }
  dom.addEventListener("click", linkClickHandler(onLink));
  return dom;
}

/** Renders a code snippet (e.g. a signature or definition) as highlighted mono text. */
export function renderCode(text: string, language: string | null, className = "cm-lsp-code"): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = `${className} ${selectableText}`;
  const code = document.createElement("code");
  code.textContent = text;
  pre.appendChild(code);
  void highlightInto(code, text, language);
  return pre;
}
