import { useLayoutEffect, useRef, useState } from "react";
import { useTx } from "@/platform/i18n";
import { type BrowserBounds, type RequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { Button, copyText, Icon, IconButton, Input } from "@/ui";
import { appendAgentDraftBlock } from "@/workbench/contributions";
import { closeBrowser, control, useBrowserSession, visit } from "./browserSession";
import styles from "./Web.module.css";

const EDGE = 8;

function isVisibleAt(node: HTMLElement, x: number, y: number): boolean {
  if (typeof document.elementsFromPoint !== "function") {
    return document.elementFromPoint(x, y) === node;
  }
  for (const hit of document.elementsFromPoint(x, y)) {
    // Transparent full-screen cursor locks during split or scrollbar drags don't visually cover the page.
    if (hit.hasAttribute("data-drag-cursor-surface") || hit.hasAttribute("data-scrollbar-drag-surface")) continue;
    return hit === node;
  }
  return false;
}

/** Native siblings sit above HTML. Hide the guest when workbench popups or dialogs need that space. */
function Viewport({ id }: { id: RequestId }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = slot.current!;
    let previous = "";
    let frame = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    function sync() {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const viewport = document.documentElement.getBoundingClientRect();
      const viewportWidth = viewport.width || window.innerWidth;
      const viewportHeight = viewport.height || window.innerHeight;
      const visible =
        !document.hidden &&
        rect.width > 1 &&
        rect.height > 1 &&
        viewportWidth > 0 &&
        viewportHeight > 0 &&
        !document.querySelector('[aria-modal="true"], [data-popup]') &&
        // Corners sampled a little inside: the tool window's resize handles overlap its edges.
        isVisibleAt(node, rect.left + EDGE, rect.top + EDGE) &&
        isVisibleAt(node, rect.right - EDGE, rect.bottom - EDGE);
      const bounds: BrowserBounds | null = visible
        ? {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            viewportWidth,
            viewportHeight,
          }
        : null;
      const key = JSON.stringify({ bounds, dpr: window.devicePixelRatio });
      if (key !== previous) {
        previous = key;
        void control(id, { type: "layout", bounds });
      }
      return visible;
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(sync);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    resize.observe(document.documentElement);
    const changes = new MutationObserver(schedule);
    changes.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", sync);
    async function poll() {
      if (sync()) await control(id, { type: "status" });
      if (!stopped) timer = setTimeout(() => void poll(), 400);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", sync);
      cancelAnimationFrame(frame);
      void control(id, { type: "layout", bounds: null });
    };
  }, [id]);
  return <div ref={slot} className={styles.viewport} data-native-surface="" />;
}

/** Short single-line summary for the fenced block header, e.g. `element <button>`. */
function elementBlockInfo(html: string): string {
  const clean = html
    .replace(/[\r\n`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const label = clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
  return label ? `element ${label}` : "element";
}

export function BrowserView() {
  const project = useProject((s) => s.project);
  const remote = useRemote((s) => !!s.session);
  const t = useTx();
  return project?.trusted && !remote ? (
    <Browser key={project.root} />
  ) : (
    <p className={styles.message}>{t("Element inspection requires a trusted local project.")}</p>
  );
}

function Browser() {
  const t = useTx();
  const { id, ready, location, element, error } = useBrowserSession();
  const [draft, setDraft] = useState<string | null>(null);
  const url = draft ?? location?.url ?? "";
  const text = element ? [element.selector, element.html, element.styles].join("\n\n") : "";
  const navigate = (action: "back" | "forward") => {
    setDraft(null);
    if (id !== null) void control(id, { type: action });
  };
  return (
    <section className={styles.inspector} aria-label={t("Browser")}>
      <form
        className={styles.toolbar}
        onSubmit={(e) => {
          e.preventDefault();
          const address = url.trim();
          if (!address || (id !== null && !ready)) return;
          void visit(address).then(() => {
            if (!useBrowserSession.getState().error) setDraft((value) => (value?.trim() === address ? null : value));
          });
        }}
      >
        {ready && id !== null && (
          <>
            <IconButton icon="arrow-left" title="Back" disabled={!location?.canBack} onClick={() => navigate("back")} />
            <IconButton
              icon="arrow-right"
              title="Forward"
              disabled={!location?.canForward}
              onClick={() => navigate("forward")}
            />
            <IconButton icon="refresh" title="Reload" onClick={() => void control(id, { type: "reload" })} />
          </>
        )}
        <Input
          className={styles.address}
          aria-label={t("Local page URL")}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the panel opens to type an address
          autoFocus={id === null}
          type="url"
          required
          value={url}
          placeholder="http://localhost:3000"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        {ready && id !== null && (
          <>
            <IconButton
              icon="locate"
              title="Inspect Element"
              pressed={!!location?.inspecting}
              onClick={() => void control(id, { type: location?.inspecting ? "cancel" : "inspect" })}
            />
            <IconButton
              icon="close"
              title="Close"
              onClick={() => {
                setDraft(url);
                closeBrowser();
              }}
            />
          </>
        )}
      </form>
      {location?.inspecting && (
        <p className={styles.hint} role="status">
          {t("Click an element to inspect it")}
        </p>
      )}
      {ready && id !== null ? (
        <Viewport id={id} />
      ) : (
        !error && <p className={styles.hint}>{t("Enter a localhost URL and press Enter.")}</p>
      )}
      {error && (
        <p className={styles.hint} role="alert">
          {error}
        </p>
      )}
      {element && (
        <div className={styles.details}>
          <div className={styles.detailsHead}>
            <Icon name="locate" size={14} />
            <h3 className={styles.detailsTitle}>{t("Selected element")}</h3>
            <IconButton
              icon="close"
              size="small"
              title="Dismiss"
              className={styles.detailsDismiss}
              onClick={() => useBrowserSession.setState({ element: null })}
            />
          </div>
          <div className={styles.detailsBody}>
            <div className={styles.selector}>{element.selector}</div>
            <pre className={styles.code}>{element.styles ? `${element.html}\n\n${element.styles}` : element.html}</pre>
          </div>
          <div className={styles.detailsActions}>
            <Button size="small" variant="secondary" icon="copy" onClick={() => void copyText(text)}>
              {t("Copy")}
            </Button>
            <Button
              size="small"
              variant="primary"
              icon="toolwindow-agents"
              onClick={() => {
                if (appendAgentDraftBlock({ kind: "block", info: elementBlockInfo(element.html), text }))
                  useBrowserSession.setState({ element: null });
                else useBrowserSession.setState({ error: t("The agent composer is unavailable.") });
              }}
            >
              {t("Add to Agent Draft")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
