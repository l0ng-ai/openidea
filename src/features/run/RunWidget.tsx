import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { BarButton, Icon, IconButton, Menu, Spinner, type MenuItem } from "@/ui";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { runExecutors, useRunExecutors, useDebugRunSessions } from "@/workbench/contributions";
import { configIcon } from "./configs";
import { useRemoteLabel } from "./remote";
import { CURRENT_FILE, useRun } from "./store";
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
  const running = sessions.filter((s) => s.status === "running" || s.status === "starting");
  const debug = useDebugRunSessions((s) => s.sessions);
  const compoundRunning = compoundTargets(selected, running, debug);
  const target = selectedTarget(selectedId, running, debug);
  const { active, debugging, stopping, showLoading, launch } = useLaunchFeedback(selectedId, target, compoundRunning);
  const count = running.length + debug.length;
  const stopName = compoundRunning.length
    ? selected?.name
    : (target?.name ?? running[0]?.config.name ?? debug[0]?.name);
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
                iconSize={18}
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
              disabled={stopping || (!!target && !target.rerun)}
              onClick={() => void launch("run.run")}
            />
          </>
        ) : (
          <>
            <IconButton
              icon="run"
              size="large"
              iconSize={18}
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
              iconSize={18}
              className={styles.widgetButton}
              title={selected ? tx`Debug '${selected.name}'` : currentFile ? "Debug Current File" : "Debug"}
              shortcut={shortcutLabel("run.debug")}
              disabled={!selected && !currentFile}
              onClick={() => void launch("run.debug")}
            />
          </>
        )}
        {!showLoading && count > 0 && (
          <IconButton
            icon="stop-filled"
            aria-busy={stopping || undefined}
            size="large"
            iconSize={16}
            className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledStop)}
            title={
              stopping
                ? tx("Force Stop")
                : active || count === 1
                  ? tx`Stop '${stopName ?? ""}'`
                  : tx`Stop (${count} running)`
            }
            shortcut={shortcutLabel("run.stop")}
            onClick={() => void executeAction("run.stop", "widget")}
          />
        )}
        <IconButton
          ref={moreRef}
          icon="more"
          size="large"
          iconSize={18}
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
  const starting = !!pending || !!target?.starting || compoundRunning.some((session) => session.starting);
  const stopping = !!target?.stopping || compoundRunning.some((session) => session.stopping);
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
  const [feedback, setFeedback] = useState({ key: runningKey, settled: true });
  if (feedback.key !== runningKey) {
    setFeedback({ key: runningKey, settled: false });
  }
  useEffect(() => {
    if (runningKey === null || feedback.settled) return;
    const timer = setTimeout(() => {
      setFeedback({ key: runningKey, settled: true });
    }, RUNNING_FEEDBACK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [runningKey, feedback.settled]);
  // Keep short-lived processes in the loading phase to avoid flashing the red Stop button.
  const showLoading = !stopping && (starting || (active && !target?.paused && !feedback.settled));
  return { active, debugging, stopping, showLoading, launch };
}
