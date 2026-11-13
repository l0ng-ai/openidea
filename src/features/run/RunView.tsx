import { useEffect, useMemo, useState } from "react";
import type { RunConfig } from "@/platform/ipc";
import type { RunTargetValid } from "@/platform/remoteSettings";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { EmptyState, IconButton, SplitGroup, SplitHandle, SplitPanel, Tabs, type TabItem, T } from "@/ui";
import { executeAction } from "@/platform/actions";
import { formatBinding, hostBinding, shortcutLabel } from "@/platform/keymap";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";
import { TerminalConsole } from "./TerminalConsole";
import { runDirectory } from "./navigate";
import { remoteLabel } from "./remote";
import {
  acceptsInput,
  baseConfigOf,
  canRunSelectedTests,
  clearConsole,
  closeSessionTab,
  closeStdin,
  debugSession,
  failedTests,
  rerunFailed,
  rerunSession,
  resizeTerminal,
  runSelectedTests,
  runtime,
  sendStdin,
  setPendingInput,
  stopSession,
  useRun,
  writeTerminal,
  type RunSession,
  isLive,
} from "./store";
import { rerunFailedConfigs } from "./testing/rerun";
import { nodeOutput } from "./testing";
import { TestTreeView, formatDuration } from "./TestTreeView";
import { StackTracePanel, closeStackTrace, useStackTraces, type StackTraceTab } from "./stackTrace";
import { showApplicationUpdate, useApplicationUpdates } from "./applicationUpdate";
import { isUpdatable } from "./updatePolicies";
import { configIcon } from "./configs";
import styles from "./Run.module.css";
import { tx } from "@/platform/i18n";
import { toolWindowService } from "@/workbench/contributions";

function failed(s: RunSession): boolean {
  return s.status === "failed" || (s.status === "finished" && s.exitCode !== 0 && !s.stopped);
}

/**
 * Tab icon, IDEA's three states: the green execution arrow while the process is alive,
 * the red error badge for a failed exit, and once the process ended the run
 * configuration's own icon (Services keeps the same model, see services.tsx).
 */
export function sessionIcon(s: RunSession): string {
  if (isLive(s)) return s.config.isTest ? "check" : "run";
  if (failed(s)) return "error";
  // Ended (exit or stop): the configuration's own icon — the green arrow stays "still running".
  return configIcon(s.config);
}

export function SessionPanel({
  session,
  showLifecycle = true,
}: {
  session: RunSession;
  /** False in the Services detail: the window's own toolbar already offers Run/Debug/Stop for the selection. */
  showLifecycle?: boolean;
}) {
  const updating = useApplicationUpdates((s) => s.ids.has(session.id));
  const version = useRun((s) => s.versions[session.id] ?? 0);
  const rt = runtime(session.id);
  const [follow, setFollow] = useState(true);
  // Settings › Console › Use soft wraps is the default; the toolbar toggle overrides it for this tab.
  const defaultWrap = useWorkflowSettings((s) => s.console.softWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const softWrap = wrapOverride ?? defaultWrap;
  const [selectedTest, setSelectedTest] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const running = isLive(session);
  const cwd = runDirectory(session.config.cwd);
  const baseConfig = useRun(() => baseConfigOf(session));
  // Test results mutate in place; their version refreshes the selection.
  const failedSelection = useMemo(
    () => (running ? [] : rerunFailedConfigs(baseConfig, failedTests(session.id))),
    [running, baseConfig, session.id, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [resolvedSelection, setResolvedSelection] = useState<{
    request: Promise<RunConfig[]>;
    supported: boolean;
  } | null>(null);
  useEffect(() => {
    let current = true;
    if (failedSelection instanceof Promise) {
      void failedSelection.then((configs) => {
        if (current) setResolvedSelection({ request: failedSelection, supported: configs.length > 0 });
      });
    }
    return () => {
      current = false;
    };
  }, [failedSelection]);
  const canRerunFailed =
    failedSelection instanceof Promise
      ? resolvedSelection?.request === failedSelection && resolvedSelection.supported
      : failedSelection.length > 0;

  // Selecting a test or a group with captured output shows just that output (like IDEA).
  const testModel = useMemo(() => {
    const node = selectedTest ? rt?.tests?.get(selectedTest) : undefined;
    const output = node ? nodeOutput(node) : [];
    if (output.length === 0) return null;
    const m = new ConsoleModel();
    m.append({ kind: "stdout", text: output.join("\n") + "\n" });
    return m;
  }, [selectedTest, rt, version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rt) return null;
  const toggleWrap = () => setWrapOverride(!softWrap);

  const consoleColumn = (
    <div className={styles.consoleColumn}>
      {rt.console.dropped > 0 && !testModel && (
        <div className={styles.notice}>{tx`${rt.console.dropped.toLocaleString()} earlier lines were discarded`}</div>
      )}
      {testModel && (
        <div className={styles.notice}>
          <button type="button" className={styles.noticeLink} onClick={() => setSelectedTest(null)}>
            <T>Show all output</T>
          </button>
        </div>
      )}
      {rt.terminal && !testModel ? (
        <TerminalConsole
          output={rt.terminal}
          cwd={cwd}
          onData={(data) => writeTerminal(session.id, data)}
          onResize={(cols, rows) => resizeTerminal(session.id, cols, rows)}
          aria-label={tx`${session.config.name} terminal`}
        />
      ) : (
        <ConsoleView
          model={testModel ?? rt.console}
          version={version}
          softWrap={softWrap}
          follow={testModel ? false : follow}
          onFollowChange={setFollow}
          findOpen={findOpen}
          onFindOpenChange={setFindOpen}
          cwd={cwd}
          onClear={() => clearConsole(session.id)}
          input={
            !testModel && acceptsInput(session)
              ? {
                  pending: rt.input,
                  onChange: (text) => setPendingInput(session.id, text),
                  onSubmit: (line) => void sendStdin(session.id, line),
                  onEof: () => void closeStdin(session.id),
                }
              : undefined
          }
          aria-label={tx`${session.config.name} output`}
        />
      )}
    </div>
  );

  return (
    <div className={styles.session}>
      <div className={styles.toolbar} role="toolbar" aria-orientation="vertical" aria-label={tx("Run actions")}>
        {showLifecycle && (
          <>
            <IconButton
              icon="rerun"
              title="Rerun"
              shortcut={shortcutLabel("run.rerun")}
              onClick={() => rerunSession(session.id)}
            />
            {/* Switch the launch mode: the same configuration started under the debugger. */}
            <IconButton
              icon="debug"
              title="Debug"
              shortcut={shortcutLabel("run.debug")}
              onClick={() => void debugSession(session.id)}
            />
            {rt.tests && (
              <IconButton
                icon="rerun"
                tone="danger"
                title="Rerun Failed Tests"
                shortcut={shortcutLabel("run.rerunFailed")}
                disabled={!canRerunFailed}
                onClick={() => void rerunFailed(session.id)}
              />
            )}
            <IconButton
              icon="stop"
              title={session.status === "stopping" ? tx`Stopping… (click to kill)` : "Stop"}
              tone={running ? "danger" : "default"}
              disabled={!running}
              onClick={() => void stopSession(session.id)}
            />
            {isUpdatable(session.config) && (
              <IconButton
                icon="refresh"
                title="Update Application"
                shortcut={shortcutLabel("run.updateApplication")}
                disabled={session.status !== "running" || updating}
                onClick={() => showApplicationUpdate(session.id)}
              />
            )}
            <div className={styles.toolbarSep} />
          </>
        )}
        {!rt.terminal && (
          <>
            <IconButton
              icon="search"
              title="Find…"
              shortcut={formatBinding(hostBinding("Meta+F"))}
              pressed={findOpen}
              onClick={() => setFindOpen((v) => !v)}
            />
            <IconButton
              icon="scroll-to-end"
              title="Scroll to End"
              pressed={follow}
              onClick={() => setFollow((v) => !v)}
            />
            <IconButton icon="soft-wrap" title="Soft-Wrap" pressed={softWrap} onClick={toggleWrap} />
          </>
        )}
        <IconButton icon="trash" title="Clear All" onClick={() => clearConsole(session.id)} />
        <div className={styles.toolbarSep} />
        <IconButton
          icon="settings"
          title="Edit Configurations…"
          onClick={() => void executeAction("run.editConfigs", session.config.id)}
        />
      </div>
      <div className={styles.sessionBody}>
        {rt.tests ? (
          <SplitGroup orientation="horizontal" id={`run-tests-${session.id}`} className={styles.testSplit}>
            <SplitPanel id="tests" defaultSize="32%" minSize="140px">
              <TestTreeView
                results={rt.tests}
                version={version}
                cwd={cwd}
                running={running}
                selected={selectedTest}
                onSelect={setSelectedTest}
                canRunTests={(ids) => canRunSelectedTests(session.id, ids)}
                onRunTests={(ids, debug) => void runSelectedTests(session.id, ids, debug)}
              />
            </SplitPanel>
            <SplitHandle />
            <SplitPanel id="console" minSize="200px">
              {consoleColumn}
            </SplitPanel>
          </SplitGroup>
        ) : (
          consoleColumn
        )}
      </div>
    </div>
  );
}

function sessionItems(sessions: readonly RunSession[], targets: readonly RunTargetValid[]): TabItem[] {
  return sessions.map((s) => ({
    id: s.id,
    label: remoteLabel(s.config, targets),
    text: remoteLabel(s.config, targets),
    icon: sessionIcon(s),
    color: failed(s) ? "var(--danger)" : undefined,
    closable: true,
    tooltip:
      s.status === "finished"
        ? tx`Finished in ${formatDuration((s.endedAt ?? s.startedAt) - s.startedAt)}, exit code ${s.exitCode ?? "?"}`
        : undefined,
  }));
}

/** The selected tab: a run session or an analyzed stack trace (IDEA shows both in Run). */
function currentTab(
  sessions: readonly RunSession[],
  traces: readonly StackTraceTab[],
  active: string | null,
): { session: RunSession } | { trace: StackTraceTab } | null {
  const session = sessions.find((s) => s.id === active);
  if (session) return { session };
  const trace = traces.find((t) => t.id === active);
  if (trace) return { trace };
  if (sessions.length) return { session: sessions[sessions.length - 1]! };
  return traces.length ? { trace: traces[traces.length - 1]! } : null;
}

/** Closes a session or stack trace tab; as in IDEA, the tool window goes away with its last tab. */
export async function closeRunTab(id: string, traces: readonly StackTraceTab[]) {
  if (traces.some((t) => t.id === id)) closeStackTrace(id);
  else if (!(await closeSessionTab(id))) return;
  if (!useRun.getState().sessions.length && !useStackTraces.getState().tabs.length) toolWindowService().hide("run");
}

/** Session (and stack trace) tabs in the tool window header. */
export function RunTabs() {
  const sessions = useRun((s) => s.sessions);
  const traces = useStackTraces((s) => s.tabs);
  const runTargets = useWorkflowSettings((s) => s.runTargets);
  const active = useRun((s) => s.activeSession);
  const current = currentTab(sessions, traces, active);
  if (!current) return null;
  const items: TabItem[] = [
    ...sessionItems(sessions, runTargets),
    ...traces.map((t) => ({ id: t.id, label: t.title, text: t.title, closable: true })),
  ];
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      aria-label="Run sessions"
      items={items}
      activeId={"session" in current ? current.session.id : current.trace.id}
      onSelect={(id) => useRun.setState({ activeSession: id })}
      onClose={(id) => void closeRunTab(id, traces)}
      panelIdPrefix="openidea-run"
    />
  );
}

export function RunView() {
  const sessions = useRun((s) => s.sessions);
  const traces = useStackTraces((s) => s.tabs);
  const active = useRun((s) => s.activeSession);
  const current = currentTab(sessions, traces, active);

  if (!current) {
    // IDEA's empty Run tool window: the three ways to run something.
    const chooser = shortcutLabel("run.chooseConfig");
    return (
      <EmptyState>
        <div className={styles.emptyHints}>
          <T>To run your code, do one of the following:</T>
          <ul>
            <li>
              <T>Click the Run icon in the editor gutter</T>
            </li>
            <li>
              <T>{'Select "Run…" in the editor context menu'}</T>
            </li>
            <li>
              <T>Launch a</T>{" "}
              <button type="button" className={styles.noticeLink} onClick={() => void executeAction("run.editConfigs")}>
                <T>run configuration</T>
              </button>
              {chooser && <span className={styles.chooserMuted}> ({chooser})</span>}
            </li>
          </ul>
        </div>
      </EmptyState>
    );
  }

  const id = "session" in current ? current.session.id : current.trace.id;
  return (
    <div className={styles.root}>
      <div
        className={styles.panel}
        role="tabpanel"
        id={`openidea-run-panel-${id}`}
        aria-labelledby={`openidea-run-tab-${id}`}
      >
        {"session" in current ? (
          <SessionPanel key={id} session={current.session} />
        ) : (
          <StackTracePanel key={id} tab={current.trace} />
        )}
      </div>
    </div>
  );
}
