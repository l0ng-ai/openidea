/**
 * reStructuredText files as PyCharm opens them: the source with a live preview beside it (Editor
 * Only / Editor and Preview / Preview Only). docutils renders it in the project's interpreter.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import clsx from "clsx";
import { editorsFor } from "@/editor/api";
import { highlightInto } from "@/editor/lsp/markdown";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { maybeEditorService } from "@/workbench/contributions";
import { EmptyState, FloatingToolbar, Spinner, SplitGroup, SplitHandle, SplitPanel, selectableText } from "@/ui";
import { modeOf } from "../layoutModes";
import { ANCHOR_PREFIX, resolveLink, sanitizePreviewHtml } from "../markdown/render";
import { imageUrl } from "../previewImages";
import { useLiveRst } from "./live";
import { RstLayoutActions, rstModes } from "./RstLayoutActions";
import styles from "../markdown/Markdown.module.css";
import rstStyles from "./Rst.module.css";

const SPLIT_STORAGE_KEY = "openidea.rst.split";
const DEFAULT_SPLIT_LAYOUT = { editor: 50, preview: 50 };

type Rendered = { html: string } | { error: string };

/** Puts docutils' `html` into `root`: sanitized, local images loaded, code highlighted. */
function fill(root: HTMLElement, html: string, path: string, isLive: () => boolean) {
  const template = document.createElement("template");
  template.innerHTML = sanitizePreviewHtml(html);
  root.replaceChildren(template.content);
  root.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
    const src = img.dataset.src ?? "";
    if (/^data:image\//i.test(src)) {
      img.src = src;
      return;
    }
    const target = resolveLink(path, src);
    if (target?.kind !== "file") {
      img.classList.add(styles.blocked!);
      img.title = tx("Remote images are not loaded");
      return;
    }
    imageUrl(target.path).then(
      (url) => {
        if (isLive()) img.src = url;
      },
      () => {
        if (isLive()) img.classList.add(styles.blocked!);
      },
    );
  });
  root.querySelectorAll<HTMLElement>("pre.code > code").forEach((code) => {
    const lang = [...code.parentElement!.classList].find((c) => c !== "code" && c !== "literal-block") ?? null;
    void highlightInto(code, code.textContent ?? "", lang);
  });
}

function RstPreview({ path }: { path: string }) {
  const text = useLiveRst((s) => s[path]);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (text === undefined) return;
    let live = true;
    const request = nextRequestId();
    call(commands.rstPreview(request, path, text))
      .then(
        (html) => live && setRendered({ html }),
        (e: unknown) => live && !isCancelled(e) && setRendered({ error: String((e as Error)?.message ?? e) }),
      )
      .finally(() => {
        live = false;
      });
    return () => {
      // Newer text replaces this render: stop its interpreter rather than let it finish.
      if (live) void commands.cancelRequest(request);
      live = false;
    };
  }, [path, text]);

  const html = rendered && "html" in rendered ? rendered.html : null;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || html === null) return;
    let live = true;
    fill(root, html, path, () => live);
    return () => {
      live = false;
    };
  }, [html, path]);

  const scrollTo = (id: string) =>
    ref.current?.querySelector(`[id="${CSS.escape(ANCHOR_PREFIX + id)}"]`)?.scrollIntoView();
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const target = resolveLink(path, a.getAttribute("href") ?? "");
    if (!target) return;
    if (target.kind === "external") void openExternalUrl(target.url);
    else if (target.kind === "anchor") scrollTo(target.id);
    else if (target.path === path && target.anchor) scrollTo(target.anchor);
    else
      void maybeEditorService()?.openFile(target.path, {
        focus: true,
        ...(target.line !== undefined ? { selection: { line: target.line, col: 0 } } : {}),
      });
  };

  const error = rendered && "error" in rendered ? rendered.error : null;
  return (
    <div className={styles.previewPane}>
      {!rendered && <Spinner label={tx("Loading")} />}
      {error && <EmptyState title={tx("Cannot preview reStructuredText")}>{error}</EmptyState>}
      {/* Kept mounted while an error shows, so the last preview comes back with its scroll position. */}
      <div
        ref={ref}
        hidden={!html || !!error}
        className={clsx(styles.preview, rstStyles.preview, selectableText)}
        tabIndex={-1}
        role="document"
        aria-label={tx("reStructuredText preview")}
        onClick={onClick}
      />
    </div>
  );
}

export function RstEditor({
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
  const mode = rstModes.useModes((s) => modeOf(s, tabId));
  useEffect(() => rstModes.pin(tabId), [tabId]);
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // CodeMirror skips resizes right after a view update; re-measure on drags and mode changes.
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
  return (
    <div ref={ref} className={clsx(styles.split, styles[`mode-${mode}`])}>
      <SplitGroup
        orientation="horizontal"
        className={styles.group}
        storageKey={mode === "split" ? SPLIT_STORAGE_KEY : undefined}
        defaultLayout={mode === "split" ? DEFAULT_SPLIT_LAYOUT : undefined}
      >
        {/* Hidden but mounted in Preview Only, so the document stays open (see MarkdownEditor). */}
        <SplitPanel id="editor" style={{ overflow: "hidden" }} disabled={mode === "preview"} {...splitBounds}>
          <div ref={editorRef} className={styles.editor}>
            {children}
          </div>
        </SplitPanel>
        {mode === "split" && <SplitHandle aria-label={tx("Resize reStructuredText preview")} />}
        {mode !== "editor" && (
          <SplitPanel id="preview" style={{ overflow: "hidden" }} {...splitBounds}>
            <RstPreview path={path} />
          </SplitPanel>
        )}
      </SplitGroup>
      {!actionsInTabs && (
        <FloatingToolbar targetRef={ref}>
          <RstLayoutActions path={path} tabId={tabId} />
        </FloatingToolbar>
      )}
    </div>
  );
}
