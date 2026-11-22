/**
 * Text editor wrapper of Markdown files: the editor, a live preview, or both,
 * switched from the tab strip or a floating toolbar. The
 * preview follows the editor's scroll position in the split layout; Preview
 * only, it follows navigation in the hidden editor and reports the line on
 * screen (Structure's Autoscroll from Source).
 */
import {
  Suspense,
  use,
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
import { useMarkdownPreviewFontSize, useMarkdownPreviewLayout } from "@/platform/languageSettings";
import { maybeEditorService, registerFontZoomSurface } from "@/workbench/contributions";
import { editorsFor, setShownLine } from "@/editor/api";
import { highlightInto } from "@/editor/lsp/markdown";
import { FloatingToolbar, Spinner, SplitGroup, SplitHandle, SplitPanel, selectableText } from "@/ui";
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
import { followMarkdownSource } from "./splitScroll";
import {
  installMarkdownSourceScroll,
  publishPreviewSelection,
  publishPreviewTop,
  stepMarkdownPreviewFontZoom,
  useLiveMarkdown,
} from "./live";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import { hasMermaid, MERMAID_SELECTOR, renderMermaidIn } from "./mermaid";
import { renderMath } from "@/editor/lsp/markdownMath";
import type { renderMathSvg } from "./mathSvg";
import { modeOf, pinMarkdownMode, useMarkdownModes } from "./modes";
import { MarkdownLayoutActions } from "./MarkdownLayoutActions";
import {
  ANCHOR_PREFIX,
  createMarkdownRenderer,
  headingLine,
  previewLineAtOffset,
  previewOffsetForLine,
  resolveLink,
  slugify,
} from "./render";
import { applyImageZoomWidth, svgDataUrlSize } from "@/ui/svgSize";
import styles from "./Markdown.module.css";
import { tx } from "@/platform/i18n";
import { wheelZoomStep } from "@/platform/wheelZoom";
import { isMarkdownPath } from "../fileKinds";
import { attachPanZoom } from "../panZoom";

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

/**
 * Line of the heading `anchor` in the Markdown file `path`, from an open editor's text (unsaved
 * edits included) or else the file on disk; undefined when the file is not Markdown, cannot be
 * read or has no such heading.
 */
async function anchorLine(path: string, anchor: string): Promise<number | undefined> {
  if (!isMarkdownPath(path, "source")) return undefined;
  const open = editorsFor(path)[0];
  const text = open ? open.view.state.doc.toString() : await call(commands.fsReadText(path)).catch(() => null);
  return (text === null ? null : headingLine(text, anchor)) ?? undefined;
}

function openExternal(url: string) {
  if (isTauri()) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => {});
  else window.open(url, "_blank", "noopener");
}

/** Wrapper that gives each preview image its own ⌘/Ctrl+wheel pan/zoom, like a Mermaid diagram. */
const IMAGE_ZOOM = "image-zoom";

function attachImagePanZoom(img: HTMLImageElement): void {
  if (img.closest(`.${IMAGE_ZOOM}`)) return;
  const box = document.createElement("span");
  box.className = IMAGE_ZOOM;
  img.replaceWith(box);
  box.append(img);
  attachPanZoom(box);
}

const SPLIT_STORAGE_KEY = "openidea.markdown.split";
const DEFAULT_SPLIT_LAYOUT = { editor: 50, preview: 50 };

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
  const mode = useMarkdownModes((s) => modeOf(s, tabId));
  const stacked = useMarkdownPreviewLayout() === "stacked";
  useEffect(() => pinMarkdownMode(tabId), [tabId]);
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "split" && editorRef.current) return installMarkdownSourceScroll(editorRef.current);
  }, [mode]);

  // CodeMirror's internal ResizeObserver skips resizes within 75ms of a view update
  // and debounces by 50ms; re-measure immediately on drag and mode transitions.
  useEffect(() => {
    const el = editorRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (next === width) return;
      width = next;
      if (next <= 0) return;
      for (const ed of editorsFor(path)) {
        if (!ed.tabId || ed.tabId === tabId) ed.view.requestMeasure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [path, tabId]);

  const splitBounds = mode === "split" ? { minSize: "10%", maxSize: "90%" } : {};
  const storageKey = stacked ? `${SPLIT_STORAGE_KEY}.stacked` : SPLIT_STORAGE_KEY;
  return (
    <div ref={ref} className={clsx(styles.split, styles[`mode-${mode}`])}>
      <SplitGroup
        orientation={stacked ? "vertical" : "horizontal"}
        className={styles.group}
        storageKey={mode === "split" ? storageKey : undefined}
        defaultLayout={mode === "split" ? DEFAULT_SPLIT_LAYOUT : undefined}
      >
        {/* Hidden but mounted in Preview only (its caret drives the preview). Disabled, it leaves the group a
            single resizable panel: two enabled panels without a separator get an implicit resize region between
            them, which for a hidden panel spans everything left of the preview. */}
        <SplitPanel id="editor" style={{ overflow: "hidden" }} disabled={mode === "preview"} {...splitBounds}>
          <div ref={editorRef} className={styles.editor}>
            {children}
          </div>
        </SplitPanel>
        {mode === "split" && <SplitHandle aria-label={tx("Resize Markdown preview")} />}
        {mode !== "editor" && (
          <SplitPanel id="preview" style={{ overflow: "hidden" }} {...splitBounds}>
            <Suspense
              fallback={
                <div className={styles.preview}>
                  <Spinner label={tx("Loading")} />
                </div>
              }
            >
              <MarkdownPreview path={path} sync={mode === "split"} />
            </Suspense>
          </SplitPanel>
        )}
      </SplitGroup>
      {!actionsInTabs && (
        <FloatingToolbar targetRef={ref}>
          <MarkdownLayoutActions path={path} tabId={tabId} />
        </FloatingToolbar>
      )}
    </div>
  );
}

function blocksOf(root: HTMLElement) {
  const blocks = [];
  for (const el of root.querySelectorAll<HTMLElement>(":scope > [data-preview-blocks] > [data-line]")) {
    const line = Number(el.dataset.line);
    const endLine = Number(el.dataset.endLine);
    const table = el.firstElementChild;
    if (
      table instanceof HTMLTableElement &&
      table.hasAttribute("data-markdown-table") &&
      table.rows.length + 1 === endLine - line
    ) {
      for (const [i, row] of Array.from(table.rows).entries()) {
        const start = i === 0 ? line : line + i + 1;
        blocks.push({
          line: start,
          endLine: i === 0 ? line + 2 : start + 1,
          get top() {
            return row.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
          },
          get bottom() {
            return row.getBoundingClientRect().bottom - root.getBoundingClientRect().top + root.scrollTop;
          },
        });
      }
    } else {
      blocks.push({
        line,
        endLine,
        get top() {
          return el.offsetTop;
        },
        get bottom() {
          return el.offsetTop + el.offsetHeight;
        },
      });
    }
  }
  return blocks;
}

let svgRenderer: Promise<typeof renderMathSvg | null> | undefined;

function loadSvgRenderer() {
  return (svgRenderer ??= import("./mathSvg").then(
    (module) => module.renderMathSvg,
    () => null,
  ));
}

function MarkdownPreview({ path, sync }: { path: string; sync: boolean }) {
  const text = useLiveMarkdown((s) => s[path]?.text);
  const fontZoom = useLiveMarkdown((s) => s[path]?.fontZoom ?? 0);
  const fontSize = useMarkdownPreviewFontSize();
  const zoomScale = Number((Math.max(4, fontSize + fontZoom) / fontSize).toFixed(4));
  const follower = useRef<ReturnType<typeof followMarkdownSource> | null>(null);
  const caretLine = useLiveMarkdown((s) => s[path]?.caretLine ?? 0);
  const caretSeq = useLiveMarkdown((s) => s[path]?.caretSeq ?? 0);
  const find = useLiveMarkdown((s) => s[path]?.find ?? null);
  const editorSelection = useLiveMarkdown((s) => s[path]?.editorSelection ?? "");
  const highlightSelection = useEditorPrefs().codeEditing.highlightSelection;
  const deferred = useDeferredValue(text ?? "");
  const [render] = useState(createMarkdownRenderer);
  const html = useMemo(() => render(deferred), [render, deferred]);
  const markup = useMemo(() => ({ __html: html }), [html]);
  const sourceOffsets = useMemo(() => {
    if (!sync) return undefined;
    const offsets = [0];
    for (let i = deferred.indexOf("\n"); i !== -1; i = deferred.indexOf("\n", i + 1)) offsets.push(i + 1);
    offsets.push(deferred.length);
    return offsets;
  }, [deferred, sync]);
  const renderSvg = html.includes(' data-math="') ? use(loadSvgRenderer()) : null;
  const ref = useRef<HTMLDivElement>(null);
  const linkRequest = useRef(0);
  const blocks = useRef<ReturnType<typeof blocksOf>>([]);
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

  useLayoutEffect(() => {
    toggled.current.clear();
    return () => {
      linkRequest.current++;
    };
  }, [path]);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll("details").forEach((d, i) => {
      const open = toggled.current.get(i);
      if (open !== undefined) d.open = open;
    });
  }, [html]);

  // Math before the preview index: typesetting changes the blocks' heights.
  useLayoutEffect(() => {
    if (!ref.current) return;
    renderSvg?.(ref.current);
    renderMath(ref.current);
    blocks.current = blocksOf(ref.current);
    invalidatePreviewIndex(ref.current);
  }, [html, renderSvg]);

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
    const size = (img: HTMLImageElement, intrinsic?: { w: number; h: number } | null) =>
      applyImageZoomWidth(img, intrinsic, img.closest<HTMLElement>(`.${IMAGE_ZOOM}`) ?? img);
    const bindImageUrl = (img: HTMLImageElement, url: string, asyncLoad: boolean) => {
      const svgSize = svgDataUrlSize(url);
      if (svgSize && size(img, svgSize) && asyncLoad) {
        setDiagramsDrawn((n) => n + 1);
      }
      img.onload = () => {
        if (!live) return;
        if (!img.hasAttribute("data-natural-width") && img.naturalWidth > 0 && img.naturalHeight > 0) {
          if (size(img, { w: img.naturalWidth, h: img.naturalHeight })) {
            setDiagramsDrawn((n) => n + 1);
          }
        } else if (asyncLoad) {
          setDiagramsDrawn((n) => n + 1);
        }
      };
      img.src = url;
      if (!img.hasAttribute("data-natural-width") && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        size(img, { w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    const imgs = [...root.querySelectorAll<HTMLImageElement>("img[data-src]")];
    imgs.forEach((img) => {
      attachImagePanZoom(img);
      size(img);
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

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !sync) return;
    const follow = followMarkdownSource(path, root, (line) =>
      line <= 0 ? 0 : previewOffsetForLine(blocks.current, line, root.scrollHeight, sourceOffsets),
    );
    follower.current = follow;
    return () => {
      follow.dispose();
      follower.current = null;
    };
  }, [path, sync, sourceOffsets]);

  useLayoutEffect(() => {
    follower.current?.align();
  }, [path, sync, html, sourceOffsets, diagramsDrawn, fontZoom, fontSize]);

  useEffect(() => {
    const root = ref.current;
    if (!root || !window.IntersectionObserver || !window.ResizeObserver) return;
    const visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) entry.target.toggleAttribute("data-in-viewport", entry.isIntersecting);
      },
      { root, rootMargin: "100% 0px" },
    );
    for (const block of root.querySelectorAll(":scope > [data-preview-blocks] > [data-line]"))
      visibility.observe(block);

    let width = 0;
    let settled = 0;
    let timer: number | undefined;
    const apply = () => {
      if (!width || width === settled) return;
      const follow = follower.current;
      const top = root.scrollTop;
      const atBottom = top > 0 && top + root.clientHeight >= root.scrollHeight - 1;
      const line = !follow && top > 0 ? previewLineAtOffset(blocks.current, top) : -1;
      const block = line >= 0 ? blocks.current.find((b) => b.line === line) : undefined;
      const within = block ? top - block.top : 0;
      settled = width;
      root.removeAttribute("data-constrain-blocks");
      root.style.setProperty("--markdown-block-width", `${width}px`);
      if (follow) follow.align();
      else if (atBottom) root.scrollTop = root.scrollHeight;
      else if (block) root.scrollTop = block.top + within;
    };
    const schedule = () => {
      if (width === settled) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!document.querySelector('[data-drag-cursor-surface$="resize"], [data-separator="active"]')) apply();
      }, 150);
    };
    const sizes = new ResizeObserver(([entry]) => {
      if (!entry || width === entry.contentRect.width) return;
      width = entry.contentRect.width;
      root.toggleAttribute("data-constrain-blocks", width < settled);
      if (!settled) apply();
      else schedule();
    });
    sizes.observe(root);
    document.addEventListener("pointerup", schedule, true);
    document.addEventListener("pointercancel", schedule, true);
    window.addEventListener("blur", schedule);
    return () => {
      visibility.disconnect();
      sizes.disconnect();
      window.clearTimeout(timer);
      document.removeEventListener("pointerup", schedule, true);
      document.removeEventListener("pointercancel", schedule, true);
      window.removeEventListener("blur", schedule);
      root.style.removeProperty("--markdown-block-width");
      root.removeAttribute("data-constrain-blocks");
    };
  }, [html]);

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
    // First-open navigation can arrive before the destination's deferred Markdown is rendered.
    if (!sync && deferred !== text) return;
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
    // Back / Forward return to the line on screen: keep the restored offset within it.
    if (previewLineAtOffset(blocks.current, root.scrollTop) !== caretLine) {
      root.scrollTop = previewOffsetForLine(blocks.current, caretLine, root.scrollHeight);
      scrolledTo.current = root.scrollTop;
      restoreRetry.current = null;
    }
    setShownLine(path, caretLine);
  }, [caretSeq, caretLine, sync, path, find, deferred, text]);

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
      if (!editorPrefs().general.wheelZoom) return;
      const zoom = wheelZoomStep(e);
      if (zoom === null) return;
      // a zoomed-in diagram or image keeps the wheel for its own zoom
      if ((e.target as Element | null)?.closest?.('[data-zoomed="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (zoom) stepMarkdownPreviewFontZoom(path, root, zoom);
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
    setShownLine(path, previewLineAtOffset(blocks.current, root.scrollTop));
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
      setShownLine(path, previewLineAtOffset(blocks.current, root.scrollTop));
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
    const request = ++linkRequest.current;
    const scrollTo = (id: string) => {
      const root = ref.current;
      if (!root) return;
      const heading = root.querySelector(`[id="${CSS.escape(ANCHOR_PREFIX + slugify(id))}"]`);
      const footnote = id.startsWith(ANCHOR_PREFIX)
        ? root.querySelector(`[id="${CSS.escape(id)}"]:is([role="doc-footnote"], [role="doc-noteref"])`)
        : null;
      (footnote ?? heading)?.scrollIntoView();
    };
    if (target.kind === "external") openExternal(target.url);
    else if (target.kind === "anchor") scrollTo(target.id);
    else if (target.path === path && target.anchor) scrollTo(target.anchor);
    else
      void (async () => {
        const line = target.line ?? (target.anchor ? await anchorLine(target.path, target.anchor) : undefined);
        if (request !== linkRequest.current) return;
        await maybeEditorService()?.openFile(target.path, {
          focus: true,
          ...(line !== undefined ? { selection: { line, col: 0 } } : {}),
        });
      })();
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
    >
      <div data-preview-blocks="" dangerouslySetInnerHTML={markup} />
    </div>
  );
}
