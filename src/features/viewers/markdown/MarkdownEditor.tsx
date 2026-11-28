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
import { Text } from "@codemirror/state";
import { editorController } from "@/editor/core/controller";
import { Direction, EditorView } from "@codemirror/view";
import { call, commands, isTauri } from "@/platform/ipc";
import { editorPrefs, useEditorPrefs } from "@/platform/editorSettings";
import { useMarkdownPreviewFontSize, useMarkdownPreviewLayout } from "@/platform/languageSettings";
import { maybeEditorService, notifications, registerFontZoomSurface, useEditorShown } from "@/workbench/contributions";
import { useToolWindowLayout, viewModeOf } from "@/workbench/toolwindows/store";
import { editorsFor, setShownLine } from "@/editor/api";
import { highlightInto } from "@/editor/lsp/markdown";
import {
  FloatingToolbar,
  Scrollbar,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  hideNativeScrollbar,
  selectableText,
} from "@/ui";
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
import { declaresMathMacros, renderMath } from "@/editor/lsp/markdownMath";
import type { renderMathSvg } from "./mathSvg";
import { modeOf, pinMarkdownMode, useMarkdownModes } from "./modes";
import { MarkdownLayoutActions } from "./MarkdownLayoutActions";
import {
  ANCHOR_PREFIX,
  createMarkdownRenderer,
  headingLine,
  isRenderedFence,
  previewLineAtOffset,
  previewOffsetForLine,
  resolveLink,
  slugify,
} from "./render";
import { applyImageZoomWidth, svgDataUrlSize } from "@/ui/svgSize";
import styles from "./Markdown.module.css";
import { writeClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { wheelZoomStep } from "@/platform/wheelZoom";
import { iconNode } from "@/ui/iconNode";
import { isMarkdownPath } from "../fileKinds";
import { attachPanZoom } from "../panZoom";
import { imageUrl } from "../previewImages";

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

function sideDockChanged(next: ReturnType<typeof useToolWindowLayout.getState>, prev: typeof next) {
  const docked = (state: typeof next, side: "left" | "right") =>
    [state.visible[side], state.visible[`${side}-split`]].some(
      (id) => id && viewModeOf(id, state.viewModes) !== "undock",
    );
  return (["left", "right"] as const).some((side) => docked(next, side) !== docked(prev, side));
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
  const mode = useMarkdownModes((s) => modeOf(s, tabId));
  const stacked = useMarkdownPreviewLayout() === "stacked";
  useEffect(() => pinMarkdownMode(tabId), [tabId]);
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "split" && editorRef.current) return installMarkdownSourceScroll(editorRef.current);
  }, [mode]);

  useEffect(() => {
    const el = editorRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const viewOf = () => editorsFor(path).find((ed) => ed.tabId === tabId || el.contains(ed.view.dom))?.view;
    let width = el.clientWidth;
    let anchor: ReturnType<typeof sourceResizeAnchor>;
    let pending = false;
    const unsubscribe = useToolWindowLayout.subscribe((next, prev) => {
      if (!sideDockChanged(next, prev)) return;
      const view = viewOf();
      if (!width || !view?.lineWrapping || !view.inView) return;
      if (anchor?.view !== view || anchor.doc !== view.state.doc || anchor.top !== view.scrollDOM.scrollTop) {
        anchor = sourceResizeAnchor(view);
      }
      pending = true;
    });
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (next === width) return;
      width = next;
      const restore = pending ? anchor : undefined;
      pending = false;
      anchor = undefined;
      if (next <= 0) return;
      const view = viewOf();
      if (!view) return;
      if (restore?.view === view && restore.doc === view.state.doc) {
        const topMargin = Math.max(
          0,
          ...view.state.facet(EditorView.scrollMargins).map((margin) => margin(view)?.top ?? 0),
        );
        view.dispatch({
          effects: EditorView.scrollIntoView(restore.pos, { y: "start", yMargin: restore.inset - topMargin }),
        });
        // Read the position after CodeMirror has applied the anchor in this resize frame.
        view.lineBlockAtHeight(0);
        anchor = { ...restore, top: view.scrollDOM.scrollTop };
      } else {
        view.requestMeasure();
      }
    });
    ro.observe(el);
    return () => {
      unsubscribe();
      ro.disconnect();
    };
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
              <MarkdownPreview path={path} tabId={tabId} sync={mode === "split"} />
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

function sourceResizeAnchor(view: EditorView) {
  const scroller = view.scrollDOM;
  const top = scroller.scrollTop;
  if (top <= 0 || scroller.scrollHeight - scroller.clientHeight - top <= 1) return;
  const viewport = scroller.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  const pos = view.posAtCoords({
    x: view.textDirection === Direction.LTR ? content.left + 1 : content.right - 1,
    y: viewport.top + 2,
  });
  const coords = pos !== null ? view.coordsAtPos(pos) : null;
  if (pos !== null && coords) return { view, doc: view.state.doc, pos, inset: coords.top - viewport.top, top };
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

let lastParse: { source: Text; html: string } | undefined;
const parkedPreviews = new WeakMap<EditorView, { source: Text; root: HTMLElement; html: string }>();
const previewGraphics = new WeakMap<HTMLElement, Map<string, HTMLElement[]>>();

function previewMarkup(source: Text, render: (text: string) => string, view: EditorView | null | undefined) {
  const parked = view && parkedPreviews.get(view);
  if (parked?.source === source) return parked.html;
  if (lastParse?.source !== source) lastParse = { source, html: render(source.toString()) };
  return lastParse.html;
}

function typesetPreview(content: HTMLElement, previous: HTMLElement, svg: typeof renderMathSvg | null) {
  const inputs = [...content.querySelectorAll<HTMLElement>("[data-math], [data-mermaid]")];
  // A declaration can change the meaning of a later formula with identical source.
  const declaresMacros = inputs.some((el) => el.hasAttribute("data-math") && declaresMathMacros(el.textContent ?? ""));
  const available = previewGraphics.get(previous);
  const rendered = new Map<string, HTMLElement[]>();
  for (const input of inputs) {
    if (input.hasAttribute("data-math") && (declaresMacros || input.childElementCount)) continue;
    const key = input.outerHTML;
    const found = available?.get(key)?.pop();
    if (found) input.replaceWith(found);
    const copies = rendered.get(key);
    if (copies) copies.push(found ?? input);
    else rendered.set(key, [found ?? input]);
  }
  for (const copies of rendered.values()) copies.reverse();
  svg?.(content);
  renderMath(content);
  return rendered;
}

function attachCodeCopy(pre: HTMLElement, source: string) {
  const parent = pre.parentElement;
  if (parent?.querySelector(`:scope > .${styles.codeCopy}`)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = styles.codeCopy!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setCopied = (copied: boolean) => {
    const label = copied ? tx("Copied") + "!" : tx("Copy Code");
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren(iconNode(copied ? "check" : "copy", 14));
    button.toggleAttribute("data-copied", copied);
  };
  setCopied(false);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    // Drop the blank lines around the code, but keep the first line's indentation.
    void writeClipboardText(source.replace(/^\s*\n/, "").trimEnd()).then(
      () => {
        clearTimeout(timer);
        setCopied(true);
        timer = setTimeout(() => setCopied(false), 1500);
      },
      (error: unknown) => {
        notifications().notify({
          level: "error",
          title: tx("Cannot access the clipboard"),
          body: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });

  if (parent?.matches(MERMAID_SELECTOR)) {
    parent.append(button);
    return;
  }

  // A control inside <pre> interferes with WebKit's selection of the block
  const block = document.createElement("div");
  block.className = styles.codeBlock!;
  pre.replaceWith(block);
  block.append(pre, button);
}

function MarkdownPreview({ path, tabId, sync }: { path: string; tabId: string; sync: boolean }) {
  const shown = useEditorShown();
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
  const deferred = useDeferredValue(text ?? Text.empty);
  const [render] = useState(createMarkdownRenderer);
  const slot = editorController().slotFor(tabId);
  const html = useMemo(() => previewMarkup(deferred, render, slot?.live), [render, deferred, slot]);
  const sourceOffsets = useMemo(() => {
    if (!sync) return undefined;
    const offsets = [0];
    for (let n = 2; n <= deferred.lines; n++) offsets.push(deferred.line(n).from);
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
  const [contentHeight, setContentHeight] = useState(0);
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
  }, [path]);
  useLayoutEffect(
    () => () => {
      linkRequest.current++;
    },
    [path, shown],
  );
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const view = slot?.live;
    const parked = view && parkedPreviews.get(view);
    if (view) parkedPreviews.delete(view);
    const cached = parked?.html === html ? parked.root : null;
    if (cached !== root) {
      if (cached) {
        root.replaceChildren(...cached.children);
        const graphics = previewGraphics.get(cached);
        if (graphics) previewGraphics.set(root, graphics);
      } else {
        const content = document.createElement("div");
        content.dataset.previewBlocks = "";
        content.innerHTML = html;
        previewGraphics.set(root, typesetPreview(content, parked?.root ?? root, renderSvg));
        root.replaceChildren(content);
      }
    }
    root.querySelectorAll("details").forEach((d, i) => {
      const open = toggled.current.get(i);
      if (open !== undefined) d.open = open;
    });
    blocks.current = blocksOf(root);
    invalidatePreviewIndex(root);
    return () => {
      if (view) parkedPreviews.set(view, { source: deferred, html, root });
    };
  }, [html, deferred, slot, renderSvg]);

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
      if (img.getAttribute("src") !== url) img.src = url;
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
      const pre = code.parentElement!;
      const src = (code.textContent ?? "").replace(/\n+$/, "");
      if (isRenderedFence(pre)) attachCodeCopy(pre, src);
      if (code.closest(MERMAID_SELECTOR)) return;
      const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? null;
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
    if (!root || !sync || !shown) return;
    const follow = followMarkdownSource(path, root, (line) =>
      line <= 0 ? 0 : previewOffsetForLine(blocks.current, line, root.scrollHeight, sourceOffsets),
    );
    follower.current = follow;
    return () => {
      follow.dispose();
      follower.current = null;
    };
  }, [path, shown, sync, sourceOffsets]);

  useLayoutEffect(() => {
    follower.current?.align();
  }, [path, sync, html, sourceOffsets, diagramsDrawn, fontZoom, fontSize]);

  useEffect(() => {
    const root = ref.current;
    if (!root || !window.IntersectionObserver || !window.ResizeObserver) return;
    let width = 0;
    let settled = 0;
    let viewportWidth = root.clientWidth;
    let visibilityPaused = false;
    const visibility = new IntersectionObserver(
      (entries) => {
        // Changing which blocks use the live width can move the anchor between resize passes.
        if (width !== settled || root.clientWidth !== viewportWidth) {
          visibilityPaused = true;
          return;
        }
        for (const entry of entries) entry.target.toggleAttribute("data-in-viewport", entry.isIntersecting);
      },
      { root, rootMargin: "100% 0px" },
    );
    // The blocks to watch: the preview's content is replaced without a new `html` too (a parked
    // preview restored on a tab switch, a theme or diagram re-render).
    const observeBlocks = () => {
      visibility.disconnect();
      for (const block of root.querySelectorAll(":scope > [data-preview-blocks] > [data-line]"))
        visibility.observe(block);
    };
    observeBlocks();
    const replaced = new MutationObserver(observeBlocks);
    replaced.observe(root, { childList: true });

    let timer: number | undefined;
    let restoredTop: number | undefined;
    let anchor: { line: number; within: number; atBottom: boolean } | undefined;
    const rememberPosition = () => {
      const top = root.scrollTop;
      if (root.clientWidth !== viewportWidth || top === restoredTop) return;
      restoredTop = undefined;
      const end = root.scrollHeight;
      const line = previewLineAtOffset(blocks.current, top);
      anchor =
        top > 0
          ? {
              line,
              within: top - previewOffsetForLine(blocks.current, line, end),
              atBottom: top + root.clientHeight >= end - 1,
            }
          : undefined;
    };
    const restorePosition = () => {
      if (anchor) {
        root.scrollTop = anchor.atBottom
          ? root.scrollHeight
          : previewOffsetForLine(blocks.current, anchor.line, root.scrollHeight) + anchor.within;
        restoredTop = root.scrollTop;
      }
      viewportWidth = root.clientWidth;
      if (width === settled) {
        follower.current?.resume();
        if (visibilityPaused) {
          visibilityPaused = false;
          observeBlocks();
        }
      }
    };
    const apply = () => {
      if (!width || width === settled) return;
      const initial = !settled;
      settled = width;
      root.removeAttribute("data-constrain-blocks");
      root.style.setProperty("--markdown-block-width", `${width}px`);
      const follow = follower.current;
      if (initial && follow) follow.align();
      else restorePosition();
    };
    const schedule = () => {
      if (width === settled) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!document.querySelector('[data-drag-cursor-surface$="resize"], [data-separator="active"]')) apply();
      }, 150);
    };
    // When a resize starts, the blocks in and near the viewport by their position: they reflow
    // live even where the observer has not reported them (yet).
    const markVisible = () => {
      const top = root.scrollTop - root.clientHeight;
      const bottom = root.scrollTop + 2 * root.clientHeight;
      for (const block of root.querySelectorAll<HTMLElement>(":scope > [data-preview-blocks] > [data-line]")) {
        if (block.offsetTop > bottom) break;
        if (block.offsetTop + block.offsetHeight >= top) block.toggleAttribute("data-in-viewport", true);
      }
    };
    const sizes = new ResizeObserver(([entry]) => {
      if (!entry || width === entry.contentRect.width) return;
      width = entry.contentRect.width;
      if (settled && width !== settled) markVisible();
      root.toggleAttribute("data-constrain-blocks", width < settled);
      if (!settled) apply();
      else {
        // Visible blocks reflow at the new width before ResizeObserver runs.
        follower.current?.pause();
        restorePosition();
        schedule();
      }
    });
    rememberPosition();
    root.addEventListener("scroll", rememberPosition, { passive: true });
    sizes.observe(root);
    document.addEventListener("pointerup", schedule, true);
    document.addEventListener("pointercancel", schedule, true);
    window.addEventListener("blur", schedule);
    return () => {
      visibility.disconnect();
      replaced.disconnect();
      sizes.disconnect();
      window.clearTimeout(timer);
      root.removeEventListener("scroll", rememberPosition);
      document.removeEventListener("pointerup", schedule, true);
      document.removeEventListener("pointercancel", schedule, true);
      window.removeEventListener("blur", schedule);
      root.style.removeProperty("--markdown-block-width");
      root.removeAttribute("data-constrain-blocks");
      follower.current?.resume();
    };
  }, [html, sync]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => setContentHeight(root.scrollHeight);
    measure();
    root.addEventListener("toggle", measure, true);
    return () => root.removeEventListener("toggle", measure, true);
  }, [html, diagramsDrawn, fontZoom, fontSize]);

  // Restore Preview Only after a mode change or eviction from the kept tabs.
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
    if (!root || !shown || caretSeq === seenCaret.current) return;
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
  }, [caretSeq, caretLine, shown, sync, path, find, deferred, text]);

  // Search (⌘F) and selection occurrence highlights in the preview.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !shown) return;
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
  }, [html, path, shown, sync, find, editorSelection, highlightSelection]);

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
    const onPreviewWheel = (e: WheelEvent) => {
      if (
        e.defaultPrevented ||
        !e.cancelable ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.shiftKey ||
        e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        !e.deltaY ||
        Math.abs(e.deltaY) < Math.abs(e.deltaX)
      )
        return;
      const max = root.scrollHeight - root.clientHeight;
      if (max <= root.clientHeight || (e.deltaY > 0 ? root.scrollTop >= max : root.scrollTop <= 0)) return;
      for (let el = e.target instanceof Element ? e.target : null; el && el !== root; el = el.parentElement) {
        if (el.scrollHeight <= el.clientHeight && (!e.deltaX || el.scrollWidth <= el.clientWidth)) continue;
        const style = getComputedStyle(el);
        if (
          (el.scrollHeight > el.clientHeight && /^(auto|scroll)$/.test(style.overflowY)) ||
          (e.deltaX && el.scrollWidth > el.clientWidth && /^(auto|scroll)$/.test(style.overflowX))
        )
          return;
      }
      // WebKit decides on the first wheel event whether it can scroll ahead of paint for the entire gesture.
      e.preventDefault();
      root.scrollBy(e.deltaX, e.deltaY);
    };
    root.addEventListener("wheel", onPreviewWheel, { passive: false });
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    const release = registerFontZoomSurface(root, (delta) => stepMarkdownPreviewFontZoom(path, root, delta));
    return () => {
      root.removeEventListener("wheel", onWheel, { capture: true });
      root.removeEventListener("wheel", onPreviewWheel);
      release();
    };
  }, [path]);

  // Preview only: the line on screen when shown, then as the user scrolls;
  // cleared when the editor is back or the preview goes away.
  useEffect(() => {
    const root = ref.current;
    if (!root || sync || !shown) return;
    setShownLine(path, previewLineAtOffset(blocks.current, root.scrollTop));
    return () => setShownLine(path, null);
  }, [sync, path, shown]);
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
    <div className={styles.previewPane}>
      <div
        ref={ref}
        className={clsx(styles.preview, hideNativeScrollbar, selectableText)}
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
      />
      <Scrollbar target={ref} contentHeight={contentHeight} />
    </div>
  );
}
