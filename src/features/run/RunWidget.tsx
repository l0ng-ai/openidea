import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { BarButton, Icon, IconButton, Menu, Spinner, type MenuItem } from "@/ui";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { runExecutors, useRunExecutors, useDebugRunSessions } from "@/workbench/contributions";
import { configIcon } from "./configs";
import { useRemoteLabel } from "./remote";
import { CURRENT_FILE, useRun, isLive } from "./store";
import { compoundTargets, selectedTarget } from "./sessionTargets";
import { isDebugOnly } from "./types";
import styles from "./Run.module.css";

const RUNNING_FEEDBACK_DELAY_MS = 300;

/** Title bar: configuration chooser, Run / Debug, and Rerun / Stop while running. */
export function RunWidget() {
  const tx = useTx();
  const label = useRemoteLabel();
  const configs = useRun((s) => s.configs);
  const selectedId = useRun((s) => s.selectedId);
  const sessions = useRun((s) => s.sessions);
  const chooserOpen = useRun((s) => s.chooserOpen);
  const selected = configs.find((c) => c.id === selectedId);
  const currentFile = selectedId === CURRENT_FILE;
  // Remote JVM Debug and the like: only Debug applies, as in IDEA.
  const debugOnly = !!selected && isDebugOnly(selected);
  const running = sessions.filter((s) => isLive(s));
  const debug = useDebugRunSessions((s) => s.sessions);
  const compoundRunning = compoundTargets(selected, running, debug);
  const target = selectedTarget(selectedId, running, debug);
  const { active, debugging, showLoading, launch } = useLaunchFeedback(selectedId, target, compoundRunning);
  const stopRuns = showLoading ? running.filter((s) => s.status !== "starting" && s.config.id !== selectedId) : running;
  const stopDebug = showLoading ? debug.filter((s) => s.status !== "starting" && s.configId !== selectedId) : debug;
  const stopTarget = selectedTarget(selectedId, stopRuns, stopDebug);
  const stopCompound = compoundTargets(selected, stopRuns, stopDebug);
  const count = stopRuns.length + stopDebug.length;
  const stopping = stopRuns.some((s) => s.status === "stopping") || stopDebug.some((s) => s.status === "stopping");
  const stop = () => void executeAction("run.stop", showLoading ? "widget-running" : "widget");
  const targetStopping =
    running.some((s) => s.status === "stopping" && s.config.id === selectedId) ||
    debug.some((s) => s.status === "stopping" && s.configId === selectedId);
  const stopName = stopCompound.length
    ? selected?.name
    : (stopTarget?.name ?? stopRuns[0]?.config.name ?? stopDebug[0]?.name);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const executors = useRunExecutors((s) => s.executors);
  // IDEA: the selected configuration's other executors (Run with Coverage, Profile) come first.
  const executorItems: MenuItem[] = selected
    ? runExecutors(executors)
        .filter((e) => e.supports(selected))
        .map((e) => ({ kind: "action", action: e.action, label: e.label(selected.name), icon: e.icon }))
    : [];
  const moreItems: MenuItem[] = [
    ...executorItems,
    ...(executorItems.length ? [{ kind: "separator" } as const] : []),
    { kind: "action", action: "run.runContext" },
    { kind: "action", action: "run.debugContext" },
    { kind: "separator" },
    { kind: "action", action: "run.editConfigs" },
    { kind: "action", action: "run.reloadConfigs" },
  ];

  return (
    <div className={styles.widget}>
      <BarButton
        variant="title"
        className={styles.widgetChooser}
        tooltip={tx("Run/Debug Configurations")}
        shortcut={shortcutLabel("run.chooseConfig")}
        aria-haspopup="listbox"
        aria-expanded={chooserOpen}
        data-run-chooser=""
        onClick={() => void executeAction("run.chooseConfig", "select")}
      >
        {selected && (
          // IDEA: the configuration's type icon, with a status dot on its top-right corner while active.
          <span className={styles.widgetConfigIcon}>
            <Icon name={configIcon(selected)} size={16} />
            {active && !showLoading && (
              <span className={styles.widgetStatusDot} aria-label={debugging ? "Debugging" : "Running"} role="img" />
            )}
          </span>
        )}
        <span className={styles.widgetName}>
          {selected ? label(selected) : tx(currentFile ? "Current File" : "Select Configuration")}
        </span>
        <Icon name="chevron-down" size={14} className={styles.widgetChevron} />
      </BarButton>
      <span className={styles.widgetButtons}>
        {showLoading ? (
          <>
            {debugging && (
              <IconButton
                icon="run"
                size="large"
                iconSize={18}
                className={clsx(styles.widgetButton, styles.widgetRun)}
                title="Run"
                disabled
              />
            )}
            <span className={clsx(styles.widgetButton, styles.widgetLoading)}>
              <Spinner variant="spokes" size={18} label={tx("Starting…")} />
            </span>
            {!debugging && (
              <IconButton
                icon="debug"
                size="large"
                iconSize={18}
                className={styles.widgetButton}
                title="Debug"
                disabled
              />
            )}
          </>
        ) : active ? (
          <>
            {target?.paused && (
              <IconButton
                icon="resume"
                size="large"
                iconSize={20}
                className={styles.widgetButton}
                title="Resume Program"
                shortcut={shortcutLabel("debug.resume")}
                onClick={() => target.resume()}
              />
            )}
            <IconButton
              icon={debugging ? "restart-debug-filled" : "rerun-filled"}
              size="large"
              iconSize={16}
              className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledRun)}
              title={tx`Rerun '${selected?.name ?? target?.name ?? ""}'`}
              shortcut={shortcutLabel("run.run")}
              disabled={!!target && (!target.rerun || targetStopping)}
              onClick={() => void launch("run.run")}
            />
          </>
        ) : (
          <>
            <IconButton
              icon="run"
              size="large"
              iconSize={20}
              className={clsx(styles.widgetButton, styles.widgetRun)}
              title={
                selected
                  ? debugOnly
                    ? tx`'${selected.name}' can only be debugged`
                    : tx`Run '${selected.name}'`
                  : currentFile
                    ? "Run Current File"
                    : "Run"
              }
              shortcut={shortcutLabel("run.run")}
              disabled={(!selected && !currentFile) || debugOnly}
              onClick={() => void launch("run.run")}
            />
            <IconButton
              icon="debug"
              size="large"
              iconSize={20}
              className={styles.widgetButton}
              title={selected ? tx`Debug '${selected.name}'` : currentFile ? "Debug Current File" : "Debug"}
              shortcut={shortcutLabel("run.debug")}
              disabled={!selected && !currentFile}
              onClick={() => void launch("run.debug")}
            />
          </>
        )}
        {count > 0 &&
          (stopping ? (
            // Between Stop and the exit: a spinner says the process is shutting down, and the
            // button kills it on the next click (IDEA's Stop turns into Kill process).
            <button
              type="button"
              className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledStop, styles.widgetStopping)}
              title={tx`Kill process`}
              aria-label={tx`Kill process`}
              onClick={stop}
            >
              <Spinner size={14} />
            </button>
          ) : (
            <IconButton
              icon="stop-filled"
              size="large"
              iconSize={16}
              className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledStop)}
              title={
                stopTarget || stopCompound.length || count === 1
                  ? tx`Stop '${stopName ?? ""}'`
                  : tx`Stop (${count} running)`
              }
              shortcut={shortcutLabel("run.stop")}
              onClick={stop}
            />
          ))}
        <IconButton
          ref={moreRef}
          icon="more"
          size="large"
          iconSize={20}
          className={styles.widgetButton}
          title="More Actions"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        />
        <Menu
          open={moreOpen}
          anchor={moreRef}
          items={moreItems}
          placement="bottom-end"
          onClose={() => setMoreOpen(false)}
        />
      </span>
    </div>
  );
}

/** Keeps launch acknowledgement and the short running-state delay in one place. */
function useLaunchFeedback(
  selectedId: string | null,
  target: ReturnType<typeof selectedTarget>,
  compoundRunning: ReturnType<typeof compoundTargets>,
) {
  const [pendingLaunch, setPendingLaunch] = useState<{ configId: string | null; debug: boolean } | null>(null);
  const launching = useRef(false);
  const pending = pendingLaunch?.configId === selectedId ? pendingLaunch : null;
  const debugging = pending ? pending.debug : !!target?.debug;
  const starting =
    !!pending || target?.status === "starting" || compoundRunning.some((session) => session.status === "starting");
  const stopping = target?.status === "stopping" || compoundRunning.some((session) => session.status === "stopping");
  const launch = async (action: "run.run" | "run.debug") => {
    if (launching.current) return;
    launching.current = true;
    setPendingLaunch({ configId: selectedId, debug: action === "run.debug" });
    try {
      await executeAction(action);
    } finally {
      launching.current = false;
      setPendingLaunch(null);
    }
  };
  const active = !!target || compoundRunning.length > 0;
  const runningKey =
    active && !starting ? `${selectedId}:${target?.debug ?? false}:${target?.startedAt ?? "compound"}` : null;
  const [feedback, setFeedback] = useState({ configId: selectedId, key: runningKey, settled: true });
  if (feedback.key !== runningKey || feedback.configId !== selectedId) {
    setFeedback({
      configId: selectedId,
      key: runningKey,
      settled: feedback.configId !== selectedId || runningKey === null,
    });
  }
  useEffect(() => {
    if (runningKey === null || feedback.settled) return;
    const timer = setTimeout(() => {
      setFeedback({ configId: selectedId, key: runningKey, settled: true });
    }, RUNNING_FEEDBACK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [selectedId, runningKey, feedback.settled]);
  // Keep short-lived processes in the loading phase to avoid flashing the red Stop button.
  const showLoading = !stopping && (starting || (active && !target?.paused && !feedback.settled));
  return { active, debugging, showLoading, launch };
}
