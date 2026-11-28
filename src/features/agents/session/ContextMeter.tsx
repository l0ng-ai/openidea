import { Fragment, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type {
  AgentContextCategory,
  AgentContextUsage,
  AgentCost,
  AgentLimit,
  AgentTask,
  AgentTokens,
  AgentUsage,
} from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { reducedMotion } from "@/platform/motion";
import { Button, Icon, Popup, T, tooltipAttrs } from "@/ui";
import {
  contextShareLabel,
  costLabel,
  groupContextCategories,
  limitParts,
  meterTone,
  turnTokensLabel,
  usageLabel,
} from "../composerModel";
import { isBusy } from "../model";
import { resendMessage } from "../store";
import styles from "../Session.module.css";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function severityClassName(percent: number): string | undefined {
  const severity = meterTone(percent);
  return severity === "danger" ? styles.meterDanger : severity === "warning" ? styles.meterWarning : undefined;
}

export function ContextMeter({
  task,
  usage,
  limits,
  cost,
  turnTokens,
  now,
}: {
  task: AgentTask;
  usage: AgentUsage | null;
  limits: readonly AgentLimit[];
  cost: AgentCost | null;
  turnTokens: AgentTokens | null;
  now: number;
}) {
  const tx = useTx();
  const label = usage ? usageLabel(usage) : null;
  const alertLimits = limits
    .map((limit) => ({ window: limit.window, ...limitParts(limit, now) }))
    .filter((item) => meterTone(item.percent) !== undefined);
  const alertDetails = alertLimits.map((item) => item.detail).join(" · ");
  const baseHint = label ? `${tx("Context window")} · ${label.short}` : tx("Session Info");
  const hint = alertDetails ? `${baseHint} · ${alertDetails}` : baseHint;
  const anchor = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const open = phase === "open";
  const close = () => setPhase(reducedMotion() ? "closed" : "closing");
  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => setPhase("closed"), 100);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const contextSeverity = label ? meterTone(label.percent) : undefined;
  const contextSeverityClass = label ? severityClassName(label.percent) : undefined;
  const dashOffset = label ? RING_CIRCUMFERENCE * (1 - label.percent / 100) : RING_CIRCUMFERENCE;

  return (
    <>
      <button
        type="button"
        ref={anchor}
        className={styles.meterButton}
        data-tone={contextSeverity}
        aria-label={hint}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...tooltipAttrs(open ? undefined : hint, undefined, true)}
        onClick={() => (open ? close() : setPhase("open"))}
      >
        {label ? (
          <span className={clsx(styles.meterContext, contextSeverityClass)} data-tone={contextSeverity}>
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
          </span>
        ) : alertLimits.length === 0 ? (
          <Icon name="info" size={13} />
        ) : null}
        {alertLimits.length > 0 && (
          <>
            {label && <span className={styles.meterInlineDivider} aria-hidden />}
            <span className={styles.meterLimitAlerts}>
              {alertLimits.map((item, i) => {
                const itemSeverity = meterTone(item.percent);
                return (
                  <Fragment key={item.window}>
                    {i > 0 && (
                      <span className={styles.meterAlertDot} aria-hidden>
                        ·
                      </span>
                    )}
                    <span
                      className={clsx(styles.meterLimitAlert, severityClassName(item.percent))}
                      data-tone={itemSeverity}
                      aria-label={item.detail}
                    >
                      {item.windowShort} {item.percent}%
                    </span>
                  </Fragment>
                );
              })}
            </span>
          </>
        )}
      </button>
      <Popup
        open={phase !== "closed"}
        onClose={close}
        anchor={anchor}
        placement="top-end"
        trapFocus={open}
        role={open ? "dialog" : "presentation"}
        aria-label={tx("Session Info")}
        className={phase === "closing" ? styles.contextClosing : styles.contextPopover}
      >
        <SessionInfoDetails
          task={task}
          usage={usage}
          limits={limits}
          cost={cost}
          turnTokens={turnTokens}
          now={now}
          onClose={close}
          closing={!open}
        />
      </Popup>
    </>
  );
}

function SessionInfoDetails({
  task,
  usage,
  limits,
  cost,
  turnTokens,
  now,
  onClose,
  closing,
}: {
  task: AgentTask;
  usage: AgentUsage | null;
  limits: readonly AgentLimit[];
  cost: AgentCost | null;
  turnTokens: AgentTokens | null;
  now: number;
  onClose: () => void;
  closing: boolean;
}) {
  const canQueryBreakdown = Boolean(usage && task.capabilities?.contextUsage && task.status !== "archived");
  const [report, setReport] = useState<AgentContextUsage | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const tx = useTx();

  useEffect(() => {
    if (!canQueryBreakdown) return;
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
  }, [canQueryBreakdown, task.id]);

  const effectiveUsed = report?.totalTokens ?? usage?.used ?? 0;
  const effectiveMax = report?.maxTokens ?? usage?.size ?? 0;
  const summary = effectiveMax > 0 ? usageLabel({ used: effectiveUsed, size: effectiveMax, cost: null }) : null;
  const grouped = report ? groupContextCategories(report.categories) : null;
  const reservedTokens = report?.reservedTokens ?? (grouped?.bufferTokens || null);
  const usedBarPct = effectiveMax > 0 ? Math.max(0, Math.min(100, (effectiveUsed / effectiveMax) * 100)) : 0;
  const reservedBarPct =
    effectiveMax > 0 && reservedTokens != null && reservedTokens > 0
      ? Math.max(0, Math.min(100 - usedBarPct, (reservedTokens / effectiveMax) * 100))
      : 0;
  const limitItems = limits.map((limit) => ({ window: limit.window, ...limitParts(limit, now) }));
  const canCompact = Boolean(usage && task.commands.some((c) => c.name === "compact"));
  const contextSeverity = summary ? meterTone(summary.percent) : undefined;
  const contextSeverityClass = summary ? severityClassName(summary.percent) : undefined;

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
      <div className={styles.sessionInfoHeader}>
        <strong>
          <T>Session Info</T>
        </strong>
        {(report?.model || task.model) && (
          <span className={styles.sessionInfoModel}>{report?.model || task.model}</span>
        )}
      </div>

      {cost && (
        <div
          className={styles.sessionInfoRow}
          {...tooltipAttrs(tx("What the session has cost so far, as the agent reports it"), undefined, true)}
        >
          <span>
            <T>Session Cost</T>
          </span>
          <strong className={styles.sessionInfoStrong}>{costLabel(cost)}</strong>
        </div>
      )}

      {usage && summary && (
        <div className={styles.sessionInfoSection}>
          <div className={styles.sessionInfoSectionTitle}>
            <T>Context Window</T>
          </div>
          <div className={clsx(styles.sessionInfoRow, contextSeverityClass)} data-tone={contextSeverity}>
            <span>{summary.detail}</span>
            <span className={styles.sessionInfoPercent}>{summary.percent}%</span>
          </div>
          <div className={styles.contextProgressTrack} aria-hidden>
            <span
              className={clsx(styles.contextProgressFill, contextSeverityClass)}
              style={{ width: `${usedBarPct}%` }}
            />
            {reservedBarPct > 0 && (
              <span className={styles.contextReservedFill} style={{ width: `${reservedBarPct}%` }} />
            )}
          </div>
          {reservedBarPct > 0 && reservedTokens != null && (
            <span
              className={styles.contextReservedLegend}
              {...tooltipAttrs(
                tx("{tokens} tokens").replace("{tokens}", reservedTokens.toLocaleString()),
                undefined,
                true,
              )}
            >
              <i className={styles.contextReservedSwatch} aria-hidden />
              <span>
                <T>Reserved for response</T>
              </span>
            </span>
          )}
          {canQueryBreakdown && error && (
            <p className={styles.sessionInfoError} role="alert">
              {!report && tx("Context details unavailable") + " · "}
              {error}
            </p>
          )}
          {canQueryBreakdown && !error && !report && (
            <span className={styles.sessionInfoMuted} role="status">
              <T>Loading context details…</T>
            </span>
          )}
          {grouped && grouped.system.length > 0 && (
            <BreakdownGroup title="System" items={grouped.system} maxTokens={effectiveMax} />
          )}
          {grouped && grouped.userContext.length > 0 && (
            <BreakdownGroup title="User Context" items={grouped.userContext} maxTokens={effectiveMax} />
          )}
          {report?.isAutoCompactEnabled && report.autoCompactThreshold != null && (
            <span className={styles.sessionInfoMuted}>
              {tx("Auto-compact at {count} tokens").replace("{count}", report.autoCompactThreshold.toLocaleString())}
            </span>
          )}
          {report?.isAutoCompactEnabled === false && (
            <span className={styles.sessionInfoMuted}>
              <T>Auto-compact is off</T>
            </span>
          )}
        </div>
      )}

      {turnTokens && (
        <div className={styles.sessionInfoRow} {...tooltipAttrs(tx("Tokens of the last turn"), undefined, true)}>
          <span>
            <T>Last turn</T>
          </span>
          <span className={styles.sessionInfoValue}>{turnTokensLabel(turnTokens)}</span>
        </div>
      )}

      {limitItems.length > 0 && (
        <div className={clsx(styles.sessionInfoSection, (usage || cost || turnTokens) && styles.sessionInfoDivided)}>
          <div className={styles.sessionInfoSectionTitle}>
            <T>Usage limits</T>
          </div>
          <div className={styles.limitsList}>
            {limitItems.map((item) => {
              const severity = meterTone(item.percent);
              const severityClass = severityClassName(item.percent);
              return (
                <div key={item.window} className={clsx(styles.limitsRow, severityClass)} data-tone={severity}>
                  <div className={styles.limitsRowHeader}>
                    <span className={styles.limitsRowName}>{item.name}</span>
                    <span className={styles.limitsRowPercent}>{item.percent}%</span>
                  </div>
                  <div className={styles.limitsTrack} aria-hidden>
                    <span className={styles.limitsFill} style={{ width: `${item.percent}%` }} />
                  </div>
                  {item.resetIn && <span className={styles.limitsReset}>{tx`Resets in ${item.resetIn}`}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {canCompact && (
        <Button
          size="small"
          className={styles.contextCompact}
          disabled={sending || isBusy(task.status)}
          onClick={() => void compact()}
        >
          <T>Compact Conversation</T>
        </Button>
      )}
    </div>
  );
}

function BreakdownGroup({
  title,
  items,
  maxTokens,
}: {
  title: "System" | "User Context";
  items: readonly AgentContextCategory[];
  maxTokens: number;
}) {
  const tx = useTx();
  return (
    <div className={styles.contextBreakdownGroup}>
      <div className={styles.contextBreakdownTitle}>
        <T>{title}</T>
      </div>
      <ul className={styles.contextBreakdownList}>
        {items.map((c) => (
          <li
            key={c.name}
            className={styles.contextBreakdownRow}
            {...tooltipAttrs(tx("{tokens} tokens").replace("{tokens}", c.tokens.toLocaleString()), undefined, true)}
          >
            <span>{tx(c.name)}</span>
            <span className={styles.contextBreakdownShare}>{contextShareLabel(c.tokens, maxTokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
