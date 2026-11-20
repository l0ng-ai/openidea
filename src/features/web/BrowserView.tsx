import { useEffect, useRef, useState } from "react";
import { useTx } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId, type InspectedElement, type RequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { Button, Input } from "@/ui";
import { appendAgentDraftBlock } from "@/workbench/contributions";
import styles from "./Web.module.css";

export function BrowserView() {
  const project = useProject((s) => s.project);
  const remote = useRemote((s) => !!s.session);
  const t = useTx();
  return project?.trusted && !remote ? (
    <Inspector key={project.root} />
  ) : (
    <p className={styles.message}>{t("Element inspection requires a trusted local project.")}</p>
  );
}

function Inspector() {
  const t = useTx();
  const [url, setUrl] = useState("");
  const [element, setElement] = useState<InspectedElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<RequestId | null>(null);

  function cancel() {
    const id = pending.current;
    pending.current = null;
    if (id !== null) void commands.cancelRequest(id).catch(() => {});
  }
  useEffect(() => cancel, []);

  async function inspect() {
    if (pending.current !== null) return;
    const id = nextRequestId();
    pending.current = id;
    setBusy(true);
    setError("");
    setElement(null);
    try {
      const picked = await call(commands.webInspectElement(url.trim(), t("Click an element to inspect it"), id));
      if (pending.current === id) setElement(picked);
    } catch (e) {
      if (pending.current === id && !isCancelled(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (pending.current === id) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  const text = element ? [element.selector, element.html, element.styles].join("\n\n") : "";
  return (
    <section className={styles.inspector} aria-label={t("Browser")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor="browser-inspector-url">{t("Local page URL")}</label>
        <Input
          id="browser-inspector-url"
          type="url"
          required
          value={url}
          disabled={busy}
          placeholder="http://localhost:3000"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value);
            setElement(null);
            setError("");
          }}
        />
        {busy ? (
          <Button
            onClick={(event) => {
              event.preventDefault();
              cancel();
              setBusy(false);
            }}
          >
            {t("Cancel")}
          </Button>
        ) : (
          <Button type="submit" icon="web" disabled={!url.trim()}>
            {t("Inspect Element")}
          </Button>
        )}
      </form>
      {busy && <p role="status">{t("Click an element in the picker, or press Escape to cancel.")}</p>}
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
                setElement(null);
              else setError(t("The agent composer is unavailable."));
            }}
          >
            {t("Add to Agent Draft")}
          </Button>
        </>
      )}
    </section>
  );
}
