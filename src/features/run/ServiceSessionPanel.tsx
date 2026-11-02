/**
 * The Services detail pane of a run configuration, as in IDEA's Services window:
 * one horizontal toolbar above the content — Run / Rerun, Update, Stop, plus the
 * debugger's Resume / Pause / steps / breakpoints while a debugger is attached —
 * and the session's console filling the rest, with Threads & Variables as a
 * second tab while debugging. Sessions started here never open the Run or Debug
 * tool windows.
 */
import { useRef, useState } from "react";
import { executeAction, getAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { IconButton, Menu, Tabs, type MenuItem } from "@/ui";
import { showApplicationUpdate } from "./applicationUpdate";
import { isUpdatable } from "./updatePolicies";
import { startRun, useRun } from "./store";
import { SessionConsole, type ConsoleControls } from "./RunView";
import { liveServiceSession, serviceDebugger, stopServiceSessions, type ServiceSession } from "./serviceSessions";
import { isDebugOnly } from "./types";
import type { RunConfig } from "@/platform/ipc";
import { isLive, selectSession, useDebug } from "@/features/debugger/state";
import { setMuted, useBreakpoints } from "@/features/debugger/breakpoints/store";
import { DebugConsole } from "@/features/debugger/ui/DebugConsole";
import { ThreadsAndVariables } from "@/features/debugger/ui/DebugSessionView";
import styles from "./RunServices.module.css";

/** A debugger action run on the session: selecting it first publishes its context. */
function step(d: { id: number }, action: string, icon: string, enabled: boolean) {
  return (
    <IconButton
      icon={icon}
      title={getAction(action)?.title ?? action}
      shortcut={shortcutLabel(action)}
      size="small"
      iconSize={16}
      disabled={!enabled}
      className={styles.panelTool}
      onClick={() => {
        selectSession(d.id);
        void executeAction(action);
      }}
    />
  );
}

/** IDEA's debugger "More" items, executed on the embedded session. */
const MORE: readonly (readonly [string, string] | null)[] = [
  ["debug.forceStepOver", "force-step-over"],
  ["debug.forceStepInto", "force-step-into"],
  ["debug.smartStepInto", "smart-step-into"],
  null,
  ["debug.runToCursor", "run-to-cursor"],
  ["debug.forceRunToCursor", "force-run-to-cursor"],
  null,
  ["debug.showExecutionPoint", "show-execution-point"],
  null,
  ["debug.evaluate", "evaluate-expression"],
  ["debug.resetFrame", "reset-frame"],
];

function moreItems(d: { id: number }): MenuItem[] {
  return MORE.map((entry) =>
    entry === null
      ? { kind: "separator" as const }
      : {
          label: getAction(entry[0])?.title ?? entry[0],
          icon: getAction(entry[0])?.icon ?? entry[1],
          run: () => {
            selectSession(d.id);
            void executeAction(entry[0]);
          },
        },
  );
}

type PanelTab = "variables" | "console";

/**
 * The detail pane's permanent right-edge strip (IDEA's console controls): page
 * scrolling, soft-wrap, jump to the tail, clear — disabled while no console is
 * displayed (a group's summary, a configuration that never ran).
 */
export function ConsoleStrip({ controls }: { controls: ConsoleControls | null }) {
  return (
    <div className={styles.panelStrip}>
      <IconButton
        icon="chevron-up"
        iconSize={14}
        title="Scroll Up"
        disabled={!controls}
        onClick={() => controls?.scrollByPage(-1)}
      />
      <IconButton
        icon="chevron-down"
        iconSize={14}
        title="Scroll Down"
        disabled={!controls}
        onClick={() => controls?.scrollByPage(1)}
      />
      <IconButton
        icon="soft-wrap"
        iconSize={14}
        title="Soft-Wrap"
        pressed={controls?.wrap?.on}
        disabled={!controls?.wrap}
        onClick={() => controls?.wrap?.toggle()}
      />
      <IconButton
        icon="arrow-down"
        iconSize={14}
        title="Scroll to End"
        pressed={controls?.follow}
        disabled={!controls}
        onClick={() => controls?.scrollToEnd()}
      />
      <IconButton icon="trash" iconSize={14} title="Clear All" disabled={!controls} onClick={() => controls?.clear()} />
    </div>
  );
}

export function ServiceSessionPanel({
  config,
  execution,
}: {
  config: RunConfig;
  execution: ServiceSession | undefined;
}) {
  // Re-render on session and breakpoint changes.
  useRun((s) => s.sessions);
  const muted = useBreakpoints((s) => s.muted);
  const run = execution?.run;
  const running = !!run && (run.status === "running" || run.status === "starting");
  const live = !!execution && liveServiceSession(execution);
  const dLive = execution ? serviceDebugger(execution) : undefined;
  const dRetained = !run ? execution?.debug[0] : undefined;
  // The debugger whose views are embedded: live while it runs, retained output otherwise.
  const dbgSession = useDebug((s) => {
    const id = dLive?.id ?? dRetained?.id;
    return id != null ? s.sessions[id] : undefined;
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // The permanent right-edge strip drives whichever console is displayed.
  const [controls, setControls] = useState<ConsoleControls | null>(null);
  // Tab selection per execution, switching like the Debug window (console on start, variables on pause).
  const [view, setView] = useState<{ key: string; status: string | undefined; tab: PanelTab }>({
    key: "",
    status: undefined,
    tab: "console",
  });
  const dKey = dLive ? `${run?.id ?? "debug"}:${dLive.id}` : "";
  if (dLive && (view.key !== dKey || view.status !== dLive.status))
    setView({
      key: dKey,
      status: dLive.status,
      tab: dLive.status === "starting" ? "console" : dLive.status === "paused" ? "variables" : view.tab,
    });

  // Rerun restarts the service in its current launch mode (a debugger's rerun keeps
  // debugging); Debug switches to (or repeats) the debug launch. Neither opens a tool window.
  const rerun = () => {
    if (dLive) dLive.rerun?.();
    else if (run) void startRun(run.config, run.id, run.baseConfig, { show: false, origin: "services" });
    else void startRun(config, undefined, undefined, { show: false, origin: "services" });
  };
  const debug = () => {
    if (dLive) dLive.rerun?.();
    else void executeAction("run.debugConfig", { config, origin: "services" });
  };
  const stop = () => execution && void stopServiceSessions([execution]);

  const consoleContent = run ? (
    <SessionConsole session={run} strip={false} onControls={setControls} />
  ) : dbgSession ? (
    <DebugConsole session={dbgSession} strip={false} onControls={setControls} />
  ) : (
    <div className={styles.panelEmpty} />
  );

  return (
    <div className={styles.panel}>
      <div className={styles.panelMain}>
        <div className={styles.panelToolbar} role="toolbar" aria-label={tx("Run actions")}>
          <IconButton
            icon={running || dLive ? "rerun" : "run"}
            title={running || dLive ? "Rerun" : "Run"}
            shortcut={shortcutLabel("run.rerun")}
            disabled={!run && !dLive && isDebugOnly(config)}
            className={styles.panelTool}
            onClick={rerun}
          />
          <IconButton
            icon="debug"
            title="Debug"
            shortcut={shortcutLabel("run.debug")}
            disabled={!!dLive && !dLive.rerun}
            className={styles.panelTool}
            onClick={debug}
          />
          {isUpdatable(config) && (
            <IconButton
              icon="refresh"
              title="Update Application"
              shortcut={shortcutLabel("run.updateApplication")}
              disabled={!running && !dLive}
              className={styles.panelTool}
              onClick={() => showApplicationUpdate(run?.id ?? (dLive ? `debug:${dLive.id}` : undefined))}
            />
          )}
          <IconButton
            icon="stop"
            title="Stop"
            shortcut={shortcutLabel("run.stop")}
            tone={live ? "danger" : "default"}
            disabled={!live}
            className={styles.panelTool}
            onClick={stop}
          />
          {/* The debugger's controls while one is attached. */}
          {dLive && (
            <>
              <span className={styles.panelSep} aria-hidden />
              {step(dLive, "debug.resume", "resume", dLive.status === "paused")}
              {step(dLive, "debug.pause", "pause", dLive.status === "running")}
              {step(dLive, "debug.stepOver", "step-over", dLive.status === "paused")}
              {step(dLive, "debug.stepInto", "step-into", dLive.status === "paused")}
              {step(dLive, "debug.stepOut", "step-out", dLive.status === "paused")}
              <span className={styles.panelSep} aria-hidden />
              <IconButton
                icon="view-breakpoints"
                action="debug.viewBreakpoints"
                size="small"
                iconSize={16}
                className={styles.panelTool}
              />
              <IconButton
                icon="mute-breakpoint"
                title={muted ? "Unmute Breakpoints" : "Mute Breakpoints"}
                pressed={muted}
                size="small"
                iconSize={16}
                className={styles.panelTool}
                onClick={() => setMuted(!muted)}
              />
              <IconButton
                ref={moreRef}
                icon="more"
                title="More"
                size="small"
                iconSize={16}
                className={styles.panelTool}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
              />
              <Menu
                open={moreOpen}
                anchor={moreRef}
                items={moreItems(dLive)}
                placement="bottom-start"
                onClose={() => setMoreOpen(false)}
              />
              {/* The debug views as tabs of the same toolbar row, as in IDEA's Services window. */}
              <Tabs
                variant="compact"
                className={styles.panelTabs}
                aria-label={tx("Debug views")}
                activeId={view.tab}
                onSelect={(tab) => setView({ ...view, tab: tab as PanelTab })}
                items={[
                  { id: "variables", label: tx("Threads & Variables"), text: tx("Threads & Variables") },
                  { id: "console", label: tx("Console"), text: tx("Console") },
                ]}
              />
            </>
          )}
        </div>
        <div className={styles.panelBody}>
          {dLive && view.tab === "variables" && dbgSession && isLive(dbgSession) ? (
            <ThreadsAndVariables session={dbgSession} />
          ) : (
            consoleContent
          )}
        </div>
      </div>
      <ConsoleStrip controls={controls} />
    </div>
  );
}
