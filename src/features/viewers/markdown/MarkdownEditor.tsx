/**
 * Text editor wrapper of Markdown files: the editor, a live preview, or both
 * side by side, switched from the tab strip or a floating toolbar. The
 * preview follows the editor's scroll position in the split layout.
 */
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { call, commands, isTauri } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { highlightInto } from "@/editor/lsp/markdown";
import { FloatingToolbar, selectableText } from "@/ui";
import { isExcalidrawPath } from "../fileKinds";
import { parseExcalidrawScene, renderExcalidrawSvg } from "../excalidraw/scene";
import { useLiveMarkdown } from "./live";
import { hasMermaid, MERMAID_SELECTOR, renderMermaidIn, subscribeTheme, themeKey } from "./mermaid";
import { modeOf, useMarkdownModes } from "./modes";
import { MarkdownLayoutActions } from "./MarkdownLayoutActions";
import { ANCHOR_PREFIX, previewOffsetForLine, renderMarkdown, resolveLink, slugify } from "./render";
import styles from "./Markdown.module.css";
import { tx } from "@/platform/i18n";

/** Loaded local images by absolute path (data URLs), shared by all previews. */
const imageCache = new Map<string, Promise<string>>();
const IMAGE_CACHE_LIMIT = 64;

function imageUrl(path: string): Promise<string> {
  let p = imageCache.get(path);
  if (!p) {
    p = call(commands.fsReadImage(path));
    p.catch(() => imageCache.delete(path));
    if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(path, p);
  }
  return p;
}

function openExternal(url: string) {
  if (isTauri()) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => {});
  else window.open(url, "_blank", "noopener");
}

export function MarkdownEditor({
  path,
  tabId,
  children,
  actionsInTabs = false,
}: {
  path: string;
  tabId: string;
  children: ReactNode;
  actionsInTabs?: boolean;
}) {
  const mode = useMarkdownModes((s) => modeOf(s, path));
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={clsx(styles.split, styles[`mode-${mode}`])}>
      <div className={styles.editor}>{children}</div>
      {mode !== "editor" && <MarkdownPreview path={path} sync={mode === "split"} />}
      {!actionsInTabs && (
        <FloatingToolbar targetRef={ref}>
          <MarkdownLayoutActions path={path} tabId={tabId} />
        </FloatingToolbar>
      )}
    </div>
  );
}

function MarkdownPreview({ path, sync }: { path: string; sync: boolean }) {
  const text = useLiveMarkdown((s) => s[path]?.text);
  const fontZoom = useLiveMarkdown((s) => s[path]?.fontZoom ?? 0);
  const topLine = useLiveMarkdown((s) => s[path]?.topLine ?? 0);
  const scrollSeq = useLiveMarkdown((s) => s[path]?.scrollSeq ?? 0);
  const deferred = useDeferredValue(text ?? "");
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  const ref = useRef<HTMLDivElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  const diagrams = useRef<Node[]>([]);
  const [diagramsDrawn, setDiagramsDrawn] = useState(0);

  // Mermaid diagrams: before paint, so cached ones don't flash their source.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !hasMermaid(root)) return;
    const pass = renderMermaidIn(root, diagrams.current);
    let live = true;
    if (pass.async) void pass.done.then(() => live && setDiagramsDrawn((n) => n + 1));
    return () => {
      live = false;
      pass.cancel();
    };
  }, [html, theme]);

  // Images and code highlighting after each render.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let live = true;
    root.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
      const src = img.dataset.src ?? "";
      if (/^data:image\//i.test(src)) {
        img.src = src;
        return;
      }
      const target = resolveLink(path, src);
      if (target?.kind !== "file") {
        img.classList.add(styles.blocked!);
        img.title = "Remote images are not loaded";
        return;
      }
      if (isExcalidrawPath(target.path)) {
        call(commands.fsReadText(target.path))
          .then((raw) => {
            if (!live) return;
            const parsed = parseExcalidrawScene(raw);
            if (!parsed.scene) {
              img.classList.add(styles.blocked!);
              return;
            }
            const dark = document.documentElement.dataset.themeMode === "dark";
            const svg = renderExcalidrawSvg(parsed.scene, { dark, padding: 16, background: true });
            img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
          })
          .catch(() => live && img.classList.add(styles.blocked!));
        return;
      }
      imageUrl(target.path).then(
        (url) => live && (img.src = url),
        () => live && img.classList.add(styles.blocked!),
      );
    });
    root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
      if (code.closest(MERMAID_SELECTOR)) return;
      const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
      const src = (code.textContent ?? "").replace(/\n+$/, "");
      code.textContent = src;
      void highlightInto(code, src, lang);
    });
    return () => {
      live = false;
    };
  }, [html, path]);

  // Scroll sync: editor → preview.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !sync) return;
    const blocks = [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")].map((el) => ({
      line: Number(el.dataset.line),
      top: el.offsetTop,
    }));
    root.scrollTop = topLine <= 0 ? 0 : previewOffsetForLine(blocks, topLine, root.scrollHeight);
  }, [html, topLine, scrollSeq, sync, diagramsDrawn]);

  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const target = resolveLink(path, a.getAttribute("href") ?? "");
    if (!target) return;
    const scrollTo = (id: string) =>
      ref.current?.querySelector(`[id="${CSS.escape(ANCHOR_PREFIX + slugify(id))}"]`)?.scrollIntoView();
    if (target.kind === "external") openExternal(target.url);
    else if (target.kind === "anchor") scrollTo(target.id);
    else if (target.path === path && target.anchor) scrollTo(target.anchor);
    else
      void maybeEditorService()?.openFile(target.path, {
        focus: true,
        ...(target.line !== undefined ? { selection: { line: target.line, col: 0 } } : {}),
      });
  };

  return (
    <div
      ref={ref}
      className={clsx(styles.preview, selectableText)}
      style={{ "--markdown-font-zoom": `${fontZoom}px` } as CSSProperties}
      tabIndex={-1}
      role="document"
      aria-label={tx("Markdown preview")}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
