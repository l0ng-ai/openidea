import { useLayoutEffect, useRef, useState } from "react";
import { useTx } from "@/platform/i18n";
import { type BrowserBounds, type RequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { Button, Input } from "@/ui";
import { appendAgentDraftBlock } from "@/workbench/contributions";
import { closeBrowser, control, useBrowserSession, visit } from "./browserSession";
import styles from "./Web.module.css";

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
      const dpr = window.devicePixelRatio;
      const visible =
        !document.hidden &&
        rect.width > 1 &&
        rect.height > 1 &&
        !document.querySelector('[aria-modal="true"], [data-popup]') &&
        document.elementFromPoint(rect.left + 1, rect.top + 1) === node &&
        document.elementFromPoint(rect.right - 1, rect.bottom - 1) === node;
      const bounds: BrowserBounds | null = visible
        ? {
            x: Math.round(rect.left * dpr),
            y: Math.round(rect.top * dpr),
            width: Math.round(rect.right * dpr) - Math.round(rect.left * dpr),
            height: Math.round(rect.bottom * dpr) - Math.round(rect.top * dpr),
          }
        : null;
      const key = JSON.stringify(bounds);
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
  return <div ref={slot} className={styles.viewport} />;
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
  return (
    <section className={styles.inspector} aria-label={t("Browser")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const address = url.trim();
          void visit(address).then(() => {
            if (!useBrowserSession.getState().error) setDraft((value) => (value?.trim() === address ? null : value));
          });
        }}
      >
        <label htmlFor="browser-inspector-url">{t("Local page URL")}</label>
        <Input
          id="browser-inspector-url"
          type="url"
          required
          value={url}
          placeholder="http://localhost:3000"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={!url.trim() || (id !== null && !ready)}>
          {t("Open")}
        </Button>
      </form>
      {ready && id !== null && (
        <>
          <div className={styles.navigation} role="group" aria-label={t("Browser")}>
            <Button
              disabled={!location?.canBack}
              onClick={() => {
                setDraft(null);
                void control(id, { type: "back" });
              }}
            >
              {t("Back")}
            </Button>
            <Button
              disabled={!location?.canForward}
              onClick={() => {
                setDraft(null);
                void control(id, { type: "forward" });
              }}
            >
              {t("Forward")}
            </Button>
            <Button onClick={() => void control(id, { type: "reload" })}>{t("Reload")}</Button>
            <Button onClick={() => void control(id, { type: location?.inspecting ? "cancel" : "inspect" })}>
              {location?.inspecting ? t("Cancel") : t("Inspect Element")}
            </Button>
            <Button
              onClick={() => {
                setDraft(url);
                closeBrowser();
              }}
            >
              {t("Close")}
            </Button>
          </div>
          {location?.inspecting && <p role="status">{t("Click an element to inspect it")}</p>}
          <Viewport id={id} />
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {element && (
        <>
          <h3>{t("Selected element")}</h3>
          <pre>{text}</pre>
          <Button
            variant="primary"
            icon="toolwindow-agents"
            onClick={() => {
              if (appendAgentDraftBlock({ kind: "block", info: `text ${t("Selected element")}`, text }))
                useBrowserSession.setState({ element: null });
              else useBrowserSession.setState({ error: t("The agent composer is unavailable.") });
            }}
          >
            {t("Add to Agent Draft")}
          </Button>
        </>
      )}
    </section>
  );
}
