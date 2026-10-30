import { useRef, useState } from "react";
import clsx from "clsx";
import { BarButton, Icon, IconButton, Menu, type MenuItem } from "@/ui";
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
  const debugging = !!target?.debug;
  const active = !!target || compoundRunning.length > 0;
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
            {active && (
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
        {active ? (
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
              disabled={!!target && !target.rerun}
              onClick={() => void executeAction("run.run")}
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
              onClick={() => void executeAction("run.run")}
            />
            <IconButton
              icon="debug"
              size="large"
              iconSize={18}
              className={styles.widgetButton}
              title={selected ? tx`Debug '${selected.name}'` : currentFile ? "Debug Current File" : "Debug"}
              shortcut={shortcutLabel("run.debug")}
              disabled={!selected && !currentFile}
              onClick={() => void executeAction("run.debug")}
            />
          </>
        )}
        {count > 0 && (
          <IconButton
            icon="stop-filled"
            size="large"
            iconSize={16}
            className={clsx(styles.widgetButton, styles.widgetFilled, styles.widgetFilledStop)}
            title={active || count === 1 ? tx`Stop '${stopName ?? ""}'` : tx`Stop (${count} running)`}
            shortcut={shortcutLabel("run.stop")}
            onClick={() => void executeAction("run.stop")}
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
