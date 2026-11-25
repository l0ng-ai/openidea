import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentContextUsage, AgentTask, AgentUsage } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { reducedMotion } from "@/platform/motion";
import { Button, Popup, T, tooltipAttrs } from "@/ui";
import { meterTone, usageLabel } from "../composerModel";
import { isBusy } from "../model";
import { resendMessage } from "../store";
import styles from "../Session.module.css";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const categoryTones = new Map([
  ["System prompt", "var(--accent)"],
  ["System tools", "var(--warning)"],
  ["System tools (deferred)", "var(--fg-muted)"],
  ["Custom agents", "var(--info)"],
  ["Skills", "var(--success)"],
  ["MCP tools", "var(--warning)"],
  ["MCP tools (deferred)", "var(--fg-muted)"],
  ["MCP server instructions", "var(--warning)"],
  ["Messages", "var(--info)"],
  ["Memory files", "var(--success)"],
  ["Autocompact buffer", "var(--fg-muted)"],
  ["Free space", "var(--fg-subtle)"],
]);
const tone = (name: string) => categoryTones.get(name) ?? "var(--fg-muted)";

export function ContextMeter({ task, usage }: { task: AgentTask; usage: AgentUsage }) {
  const tx = useTx();
  const label = usageLabel(usage);
  const hint = tx("Context window") + " · " + label.short;
  const anchor = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const open = phase === "open";
  const close = () => setPhase(reducedMotion() ? "closed" : "closing");
  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => setPhase("closed"), 100);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const severity = meterTone(label.percent);
  const severityClass =
    severity === "danger" ? styles.meterDanger : severity === "warning" ? styles.meterWarning : undefined;
  const dashOffset = RING_CIRCUMFERENCE * (1 - label.percent / 100);
  const meter = (
    <>
      <svg className={styles.usageRing} viewBox="0 0 14 14" aria-hidden>
        <circle className={styles.usageRingTrack} cx="7" cy="7" r={RING_RADIUS} />
        <circle
          className={styles.usageRingArc}
          cx="7"
          cy="7"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          strokeOpacity={label.percent > 0 ? 1 : 0}
          transform="rotate(-90 7 7)"
          data-percent={label.percent}
        />
      </svg>
      <span className={styles.meterValue}>{label.percent}%</span>
    </>
  );
  if (!task.capabilities?.contextUsage)
    return (
      <span
        tabIndex={0}
        className={clsx(styles.meter, severityClass)}
        data-tone={severity}
        aria-label={hint}
        {...tooltipAttrs(hint, undefined, true)}
      >
        {meter}
      </span>
    );
  return (
    <>
      <button
        type="button"
        ref={anchor}
        className={clsx(styles.meterButton, severityClass)}
        data-tone={severity}
        aria-label={hint}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...tooltipAttrs(open ? undefined : hint, undefined, true)}
        onClick={() => (open ? close() : setPhase("open"))}
      >
        {meter}
      </button>
      <Popup
        open={phase !== "closed"}
        onClose={close}
        anchor={anchor}
        placement="top-end"
        trapFocus={open}
        role={open ? "dialog" : "presentation"}
        aria-label={tx("Context window")}
        className={phase === "closing" ? styles.contextClosing : styles.contextPopover}
      >
        <ContextDetails task={task} onClose={close} closing={!open} />
      </Popup>
    </>
  );
}

function ContextDetails({ task, onClose, closing }: { task: AgentTask; onClose: () => void; closing: boolean }) {
  const [report, setReport] = useState<AgentContextUsage | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const tx = useTx();
  useEffect(() => {
    let current = true;
    call(commands.agentContextUsage(task.id)).then(
      (value) => {
        if (current) setReport(value);
      },
      (e) => {
        if (current) setError(String(e));
      },
    );
    return () => {
      current = false;
    };
  }, [task.id]);
  const summary = report && usageLabel({ used: report.totalTokens, size: report.maxTokens, cost: null });
  const categories = report?.categories ?? [];
  const compact = async () => {
    setSending(true);
    try {
      await resendMessage(task.id, "/compact");
      onClose();
    } catch (e) {
      setError(String(e));
      setSending(false);
    }
  };
  return (
    <div className={styles.contextDetails} inert={closing}>
      <div className={styles.contextHeading}>
        <strong>
          <T>Context window</T>
        </strong>
        <span>{summary?.short}</span>
      </div>
      {error && (
        <p role="alert">
          {!report && tx("Context details unavailable") + " · "}
          {error}
        </p>
      )}
      {!error && !report && (
        <span role="status">
          <T>Loading context details…</T>
        </span>
      )}
      {report && (
        <>
          <div className={styles.contextBar} aria-hidden>
            {categories.map(
              (c) =>
                c.kind !== "deferred" &&
                c.tokens > 0 && <span key={c.name} style={{ flexGrow: c.tokens, background: tone(c.name) }} />,
            )}
          </div>
          <span>{report.model}</span>
          {report.isAutoCompactEnabled && report.autoCompactThreshold != null && (
            <span>
              {tx("Auto-compact at {count} tokens").replace("{count}", report.autoCompactThreshold.toLocaleString())}
            </span>
          )}
          <details>
            <summary>
              <T>Detailed breakdown</T>
            </summary>
            <ul>
              {categories.map((c) => (
                <li key={c.name}>
                  <i aria-hidden style={{ background: tone(c.name) }} />
                  <span>{tx(c.name)}</span>
                  <span>{c.tokens.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </details>
          {report.isAutoCompactEnabled === false && (
            <span>
              <T>Auto-compact is off</T>
            </span>
          )}
          {task.commands.some((c) => c.name === "compact") && (
            <Button
              size="small"
              className={styles.contextCompact}
              disabled={sending || isBusy(task.status)}
              onClick={() => void compact()}
            >
              <T>Compact session</T>
            </Button>
          )}
        </>
      )}
    </div>
  );
}
