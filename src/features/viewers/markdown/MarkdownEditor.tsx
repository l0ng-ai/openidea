/**
 * Text editor wrapper of Markdown files: the editor, a live preview, or both
 * side by side, switched from the tab strip or a floating toolbar. The
 * preview follows the editor's scroll position in the split layout; Preview
 * only, it follows navigation in the hidden editor and reports the line on
 * screen (Structure's Autoscroll from Source).
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
import { editorPrefs, useEditorPrefs } from "@/platform/editorSettings";
import { useMarkdownPreviewFontSize } from "@/platform/languageSettings";
import { maybeEditorService, registerFontZoomSurface } from "@/workbench/contributions";
import { setShownLine } from "@/editor/api";
import { highlightInto } from "@/editor/lsp/markdown";
import { FloatingToolbar, selectableText } from "@/ui";
import {
  FIND_CURRENT_HIGHLIGHT,
  FIND_HIGHLIGHT,
  SELECTION_MATCH_HIGHLIGHT,
  clearPreviewHighlights,
  findPreviewMatches,
  invalidatePreviewIndex,
  openDetailsContaining,
  previewSelectionOf,
  revealPreviewRange,
  selectionMatchesInNode,
  setPreviewHighlight,
} from "./highlight";
import { publishPreviewSelection, publishPreviewTop, stepMarkdownPreviewFontZoom, useLiveMarkdown } from "./live";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import { hasMermaid, MERMAID_SELECTOR, renderMermaidIn } from "./mermaid";
import { modeOf, useMarkdownModes } from "./modes";
import { MarkdownLayoutActions } from "./MarkdownLayoutActions";
import {
  ANCHOR_PREFIX,
  previewLineAtOffset,
  previewOffsetForLine,
  renderMarkdown,
  resolveLink,
  slugify,
} from "./render";
import { applyImageZoomWidth, svgDataUrlSize } from "@/ui/svgSize";
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

const blocksOf = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(":scope > [data-line]")].map((el) => ({
    line: Number(el.dataset.line),
    top: el.offsetTop,
  }));

function MarkdownPreview({ path, sync }: { path: string; sync: boolean }) {
  const text = useLiveMarkdown((s) => s[path]?.text);
  const fontZoom = useLiveMarkdown((s) => s[path]?.fontZoom ?? 0);
  const fontSize = useMarkdownPreviewFontSize();
  const zoomScale = Number((Math.max(4, fontSize + fontZoom) / fontSize).toFixed(4));
  const topLine = useLiveMarkdown((s) => s[path]?.topLine ?? 0);
  const scrollSeq = useLiveMarkdown((s) => s[path]?.scrollSeq ?? 0);
  const caretLine = useLiveMarkdown((s) => s[path]?.caretLine ?? 0);
  const caretSeq = useLiveMarkdown((s) => s[path]?.caretSeq ?? 0);
  const find = useLiveMarkdown((s) => s[path]?.find ?? null);
  const editorSelection = useLiveMarkdown((s) => s[path]?.editorSelection ?? "");
  const highlightSelection = useEditorPrefs().codeEditing.highlightSelection;
  const deferred = useDeferredValue(text ?? "");
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  const ref = useRef<HTMLDivElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  const diagrams = useRef<Node[]>([]);
  const [diagramsDrawn, setDiagramsDrawn] = useState(0);
  const seenCaret = useRef(caretSeq);
  const seenFindMatch = useRef<number | null>(null);
  /** scrollTop set by navigation, whose scroll event isn't the user's. */
  const scrolledTo = useRef<number | null>(null);
  /** The offset a mount restore clamped short of (content not drawn yet), retried on the next settle. */
  const restoreRetry = useRef<number | null>(null);
  const scrollFrame = useRef(0);
  /** `<details>` the reader opened or closed, by position: each edit re-renders them as written. */
  const toggled = useRef(new Map<number, boolean>());

  useLayoutEffect(() => toggled.current.clear(), [path]);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll("details").forEach((d, i) => {
      const open = toggled.current.get(i);
      if (open !== undefined) d.open = open;
    });
  }, [html]);

  useLayoutEffect(() => {
    if (ref.current) invalidatePreviewIndex(ref.current);
  }, [html]);

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
    const bindImageUrl = (img: HTMLImageElement, url: string, asyncLoad: boolean) => {
      const svgSize = svgDataUrlSize(url);
      if (svgSize && applyImageZoomWidth(img, svgSize) && asyncLoad) {
        setDiagramsDrawn((n) => n + 1);
      }
      img.onload = () => {
        if (!live) return;
        if (!img.hasAttribute("data-natural-width") && img.naturalWidth > 0 && img.naturalHeight > 0) {
          if (applyImageZoomWidth(img, { w: img.naturalWidth, h: img.naturalHeight })) {
            setDiagramsDrawn((n) => n + 1);
          }
        } else if (asyncLoad) {
          setDiagramsDrawn((n) => n + 1);
        }
      };
      img.src = url;
      if (!img.hasAttribute("data-natural-width") && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        applyImageZoomWidth(img, { w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    const imgs = [...root.querySelectorAll<HTMLImageElement>("img[data-src]")];
    imgs.forEach((img) => {
      applyImageZoomWidth(img);
      const src = img.dataset.src ?? "";
      if (/^data:image\//i.test(src)) {
        bindImageUrl(img, src, false);
        return;
      }
      const target = resolveLink(path, src);
      if (target?.kind !== "file") {
        img.classList.add(styles.blocked!);
        img.title = "Remote images are not loaded";
        return;
      }
      imageUrl(target.path).then(
        (url) => live && bindImageUrl(img, url, true),
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
      for (const img of imgs) img.onload = null;
    };
  }, [html, path]);

  // Scroll sync: editor → preview.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !sync) return;
    root.scrollTop = topLine <= 0 ? 0 : previewOffsetForLine(blocksOf(root), topLine, root.scrollHeight);
  }, [html, topLine, scrollSeq, sync, diagramsDrawn, fontZoom, fontSize]);

  // The preview's own scroll offset: tab switches and mode toggles unmount the
  // preview, so Preview Only would otherwise start over at the top. Writes made
  // by the split sync above are captured too — the last visible position wins.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onScroll = () => {
      // A clamped restore keeps the saved offset until it is applied in full.
      if (restoreRetry.current !== null && Math.abs(root.scrollTop - (scrolledTo.current ?? -1)) < 1) return;
      publishPreviewTop(path, root.scrollTop);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [path]);

  // Restore it on mount; in split mode the sync effect positions the preview.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || sync) return;
    const saved = useLiveMarkdown.getState()[path]?.previewTop ?? 0;
    if (saved <= 0) return;
    root.scrollTop = saved;
    scrolledTo.current = root.scrollTop;
    // Images and diagrams draw after this first paint; a clamped offset is
    // applied again by the settle effect below.
    restoreRetry.current = root.scrollTop < saved ? saved : null;
  }, [path, sync]);

  // A restore that clamped to the not-yet-drawn document is applied again on
  // each settle, until it fits or a scroll hands the position back to the reader.
  useLayoutEffect(() => {
    const root = ref.current;
    const saved = restoreRetry.current;
    if (!root || sync || saved === null) return;
    if (scrolledTo.current === null) {
      restoreRetry.current = null;
      return;
    }
    root.scrollTop = saved;
    scrolledTo.current = root.scrollTop;
    if (root.scrollTop >= saved) restoreRetry.current = null;
  }, [html, diagramsDrawn, fontZoom, fontSize, path, sync]);

  // Preview only: go where the hidden editor's caret was sent (Structure, Go to Symbol…).
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || caretSeq === seenCaret.current) return;
    seenCaret.current = caretSeq;
    if (sync) return;
    if (find && find.currentMatchIndex >= 0) {
      const { current } = findPreviewMatches(root, find);
      if (current) {
        openDetailsContaining(current, root, toggled.current);
        if (revealPreviewRange(current, root)) {
          scrolledTo.current = root.scrollTop;
          restoreRetry.current = null;
          setShownLine(path, caretLine);
          return;
        }
      }
    }
    const blocks = blocksOf(root);
    // Back / Forward return to the line on screen: keep the restored offset within it.
    if (previewLineAtOffset(blocks, root.scrollTop) !== caretLine) {
      root.scrollTop = previewOffsetForLine(blocks, caretLine, root.scrollHeight);
      scrolledTo.current = root.scrollTop;
      restoreRetry.current = null;
    }
    setShownLine(path, caretLine);
  }, [caretSeq, caretLine, sync, path, find]);

  // Search (⌘F) and selection occurrence highlights in the preview.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const applyFind = () => {
      if (!find) {
        seenFindMatch.current = null;
        setPreviewHighlight(FIND_HIGHLIGHT, root, []);
        setPreviewHighlight(FIND_CURRENT_HIGHLIGHT, root, []);
        return;
      }
      const { ranges, current } = findPreviewMatches(root, find);
      if (current) {
        openDetailsContaining(current, root, toggled.current);
        if (seenFindMatch.current !== find.currentMatchIndex) {
          seenFindMatch.current = find.currentMatchIndex;
          if (revealPreviewRange(current, root) && !sync) {
            scrolledTo.current = root.scrollTop;
            restoreRetry.current = null;
          }
        }
      } else {
        seenFindMatch.current = find.currentMatchIndex;
      }
      setPreviewHighlight(FIND_HIGHLIGHT, root, current ? ranges.filter((r) => r !== current) : ranges);
      setPreviewHighlight(FIND_CURRENT_HIGHLIGHT, root, current ? [current] : []);
    };
    const applySelection = () => {
      if (!highlightSelection) {
        publishPreviewSelection(path, "");
        setPreviewHighlight(SELECTION_MATCH_HIGHLIGHT, root, []);
        return;
      }
      const domSel = previewSelectionOf(root);
      if (domSel) {
        publishPreviewSelection(path, domSel.text);
        setPreviewHighlight(SELECTION_MATCH_HIGHLIGHT, root, selectionMatchesInNode(root, domSel.text, domSel.range));
        return;
      }
      publishPreviewSelection(path, "");
      if (editorSelection) {
        setPreviewHighlight(SELECTION_MATCH_HIGHLIGHT, root, selectionMatchesInNode(root, editorSelection, null));
        return;
      }
      setPreviewHighlight(SELECTION_MATCH_HIGHLIGHT, root, []);
    };
    const applyAll = () => {
      applySelection();
      applyFind();
    };
    applyAll();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      invalidatePreviewIndex(root);
      clearTimeout(timer);
      timer = setTimeout(applyAll, 120);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    document.addEventListener("selectionchange", applySelection);
    root.addEventListener("toggle", applyAll, true);
    return () => {
      if (observer.takeRecords().length) invalidatePreviewIndex(root);
      observer.disconnect();
      clearTimeout(timer);
      document.removeEventListener("selectionchange", applySelection);
      root.removeEventListener("toggle", applyAll, true);
    };
  }, [html, path, sync, find, editorSelection, highlightSelection]);

  useEffect(() => {
    const root = ref.current;
    return () => {
      if (root) {
        clearPreviewHighlights(root);
        invalidatePreviewIndex(root);
      }
      publishPreviewSelection(path, "");
    };
  }, [path]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if ((!e.ctrlKey && !e.metaKey) || e.deltaY === 0 || !editorPrefs().general.wheelZoom) return;
      if ((e.target as Element | null)?.closest?.('.mermaid-output[data-zoomed="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      stepMarkdownPreviewFontZoom(path, root, e.deltaY < 0 ? 1 : -1);
    };
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    const release = registerFontZoomSurface(root, (delta) => stepMarkdownPreviewFontZoom(path, root, delta));
    return () => {
      root.removeEventListener("wheel", onWheel, { capture: true });
      release();
    };
  }, [path]);

  // Preview only: the line on screen when shown, then as the user scrolls;
  // cleared when the editor is back or the preview goes away.
  useEffect(() => {
    const root = ref.current;
    if (!root || sync) return;
    setShownLine(path, previewLineAtOffset(blocksOf(root), root.scrollTop));
    return () => setShownLine(path, null);
  }, [sync, path]);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  const onScroll = () => {
    const root = ref.current;
    if (!root || sync || scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const own = scrolledTo.current !== null && Math.abs(root.scrollTop - scrolledTo.current) < 1;
      if (own) return;
      scrolledTo.current = null;
      restoreRetry.current = null;
      setShownLine(path, previewLineAtOffset(blocksOf(root), root.scrollTop));
    });
  };

  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest("a");
    if (!a) {
      const details = (e.target as Element).closest("summary")?.parentElement;
      if (details instanceof HTMLDetailsElement && ref.current) {
        toggled.current.set([...ref.current.querySelectorAll("details")].indexOf(details), !details.open);
      }
      return;
    }
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
      style={
        {
          "--markdown-preview-font-size": `${fontSize}px`,
          "--markdown-font-zoom": `${fontZoom}px`,
          "--markdown-zoom-scale": String(zoomScale),
        } as CSSProperties
      }
      tabIndex={-1}
      role="document"
      aria-label={tx("Markdown preview")}
      onClick={onClick}
      onScroll={onScroll}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
