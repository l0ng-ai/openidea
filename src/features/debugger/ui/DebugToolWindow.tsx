/** Debug tool window: toolbar, Threads & Variables (frames + variables), Console. */
import { useRef, useState } from "react";
import clsx from "clsx";
import { evaluateWhen, useContextKeys } from "@/platform/context";
import { getAction } from "@/platform/actions";
import { EmptyState, IconButton, Kbd, Menu, Tabs, T, type MenuItem, type TabItem } from "@/ui";
import { setMuted, useBreakpoints } from "../breakpoints/store";
import { rootOf, selectSession, useDebug, type DebugSession } from "../state";
import { DebugConsole } from "./DebugConsole";
import { ThreadsAndVariables } from "./DebugSessionView";
import styles from "./DebugToolWindow.module.css";
import { tx } from "@/platform/i18n";

function useActionEnabled(id: string): boolean {
  const ctx = useContextKeys();
  const a = getAction(id);
  return !!a && evaluateWhen(a.when, ctx);
}

function ToolButton({ action, icon, tone }: { action: string; icon: string; tone?: "danger" }) {
  const enabled = useActionEnabled(action);
  return (
    <IconButton
      icon={icon}
      action={action}
      size="small"
      iconSize={16}
      disabled={!enabled}
      tone={tone}
      className={styles.tool}
    />
  );
}

/** IDEA's `XDebugger.ToolWindow.TopToolbar3.Extra` ("More" in the debugger toolbar). */
const MORE_ITEMS: MenuItem[] = [
  { kind: "action", action: "debug.forceStepOver", icon: "force-step-over" },
  { kind: "action", action: "debug.forceStepInto", icon: "force-step-into" },
  { kind: "action", action: "debug.smartStepInto", icon: "smart-step-into" },
  { kind: "separator" },
  { kind: "action", action: "debug.runToCursor", icon: "run-to-cursor" },
  { kind: "action", action: "debug.forceRunToCursor", icon: "force-run-to-cursor" },
  { kind: "separator" },
  { kind: "action", action: "debug.showExecutionPoint", icon: "show-execution-point" },
  { kind: "separator" },
  { kind: "action", action: "debug.evaluate", icon: "evaluate-expression" },
  { kind: "action", action: "debug.resetFrame", icon: "reset-frame" },
];

function MoreActions() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        ref={ref}
        icon="more"
        title="More"
        size="small"
        iconSize={16}
        className={styles.tool}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu open={open} anchor={ref} items={MORE_ITEMS} placement="bottom-start" onClose={() => setOpen(false)} />
    </>
  );
}

type Tab = "variables" | "console";

function statusText(s: DebugSession): string {
  if (s.status === "terminated") return s.exitCode != null ? `Finished · exit code ${s.exitCode}` : "Finished";
  if (s.status === "starting") return "Starting…";
  return s.status === "paused" ? "Suspended" : "Running";
}

/** Sessions the Debug tool window shows: Services-owned sessions live in the Services window. */
function windowSessions(sessions: readonly DebugSession[]): DebugSession[] {
  return sessions.filter((s) => rootOf(s).origin !== "services");
}

/** Tool window header: one tab per debug session (`main ×`), like IDEA's content tabs. */
export function DebugTabs() {
  const sessions = useDebug((s) => s.sessions);
  const active = useDebug((s) => s.active);
  const list = windowSessions(Object.values(sessions));
  if (!list.length) return null;
  const items: TabItem[] = list.map((s) => ({
    id: String(s.id),
    label: s.parent != null ? tx`${s.name} (child)` : s.name,
    text: s.name,
    icon: "debug",
    italic: s.status === "terminated",
    tooltip: statusText(s),
  }));
  return (
    <Tabs
      variant="compact"
      className={styles.sessionTabs}
      aria-label="Debug sessions"
      items={items}
      activeId={active != null && list.some((s) => s.id === active) ? String(active) : null}
      onSelect={(id) => selectSession(+id)}
      panelIdPrefix="openidea-debug"
    />
  );
}

export function DebugToolWindow() {
  const active = useDebug((s) => {
    const a = s.active != null ? s.sessions[s.active] : undefined;
    // A Services-owned session's UI belongs to the Services window.
    return a && rootOf(a).origin !== "services" ? a : undefined;
  });
  const muted = useBreakpoints((s) => s.muted);
  const [view, setView] = useState<{
    session: number | undefined;
    status: DebugSession["status"] | undefined;
    tab: Tab;
  }>({ session: undefined, status: undefined, tab: "variables" });
  if (active && (view.session !== active.startedAt || view.status !== active.status))
    setView({
      session: active.startedAt,
      status: active.status,
      tab: active.status === "starting" ? "console" : active.status === "paused" ? "variables" : view.tab,
    });
  const tab = view.tab;

  if (!active) {
    return (
      <div className={styles.emptyWrap}>
        <EmptyState title="Not debugging">
          <T>Start a debug configuration with</T> <Kbd action="run.debug" />{" "}
          <T>or click a line number to set a breakpoint.</T>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Debugger actions")}>
        <div role="tablist" aria-label={tx("Debug views")} className={styles.tabs}>
          {(
            [
              ["variables", tx("Threads & Variables")],
              ["console", tx("Console")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`debug-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`debug-panel-${id}`}
              className={clsx(styles.tab, tab === id && styles.tabActive)}
              onClick={() => setView({ session: active.startedAt, status: active.status, tab: id })}
            >
              {label}
            </button>
          ))}
        </div>
        {/* IDEA's XDebugger.ToolWindow.TopToolbar3 (+ its "More" group). */}
        <span className={styles.sep} aria-hidden />
        <ToolButton action="debug.rerun" icon="rerun" />
        <ToolButton action="debug.stop" icon="stop" tone="danger" />
        <span className={styles.sep} aria-hidden />
        <ToolButton action="debug.resume" icon="resume" />
        <ToolButton action="debug.pause" icon="pause" />
        <ToolButton action="debug.stepOver" icon="step-over" />
        <ToolButton action="debug.stepInto" icon="step-into" />
        <ToolButton action="debug.stepOut" icon="step-out" />
        <span className={styles.sep} aria-hidden />
        <IconButton
          icon="view-breakpoints"
          action="debug.viewBreakpoints"
          size="small"
          iconSize={16}
          className={styles.tool}
        />
        <IconButton
          icon="mute-breakpoint"
          title={muted ? "Unmute Breakpoints" : "Mute Breakpoints"}
          pressed={muted}
          size="small"
          iconSize={16}
          className={styles.tool}
          onClick={() => setMuted(!muted)}
        />
        <MoreActions />
      </div>
      <div role="tabpanel" id={`debug-panel-${tab}`} aria-labelledby={`debug-tab-${tab}`} className={styles.panel}>
        {tab === "variables" ? (
          <ThreadsAndVariables session={active} />
        ) : (
          <DebugConsole key={active.id} session={active} />
        )}
      </div>
    </div>
  );
}
