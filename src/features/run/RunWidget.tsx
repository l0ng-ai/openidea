import { useRef, useState } from "react";
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
  const count = running.length + debug.length;
  const stopping = running.some((s) => s.status === "stopping") || debug.some((s) => s.status === "stopping");
  const stop = () => void executeAction("run.stop", "widget");
  const targetStopping =
    running.some((s) => s.status === "stopping" && s.config.id === selectedId) ||
    debug.some((s) => s.status === "stopping" && s.configId === selectedId);
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
              title={active || count === 1 ? tx`Stop '${stopName ?? ""}'` : tx`Stop (${count} running)`}
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

/** Acknowledges widget clicks before a session exists; session state covers other entry points. */
function useLaunchFeedback(
  selectedId: string | null,
  target: ReturnType<typeof selectedTarget>,
  compoundRunning: ReturnType<typeof compoundTargets>,
) {
  const [pendingLaunches, setPendingLaunches] = useState<{ configId: string | null; debug: boolean }[]>([]);
  const launching = useRef(new Set<string | null>());
  const pending = pendingLaunches.find((launch) => launch.configId === selectedId);
  const debugging = pending ? pending.debug : !!target?.debug;
  const starting =
    !!pending || target?.status === "starting" || compoundRunning.some((session) => session.status === "starting");
  const stopping = target?.status === "stopping" || compoundRunning.some((session) => session.status === "stopping");
  const launch = async (action: "run.run" | "run.debug") => {
    if (launching.current.has(selectedId)) return;
    launching.current.add(selectedId);
    setPendingLaunches((pending) => [...pending, { configId: selectedId, debug: action === "run.debug" }]);
    try {
      await executeAction(action);
    } finally {
      launching.current.delete(selectedId);
      setPendingLaunches((pending) => pending.filter((launch) => launch.configId !== selectedId));
    }
  };
  const active = !!target || compoundRunning.length > 0;
  const showLoading = !stopping && starting;
  return { active, debugging, showLoading, launch };
}
