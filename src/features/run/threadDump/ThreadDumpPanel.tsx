/** A thread dump tab of the Run tool window: the deadlocks, the threads, and the selected one's stack. */
import { Fragment, useMemo, useState } from "react";
import { toBase64 } from "@/platform/base64";
import { writeClipboardText } from "@/platform/clipboard";
import { save as saveDialog } from "@/platform/dialog";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { Icon, IconButton, List, SearchField, SplitGroup, SplitHandle, SplitPanel, T, Toolbar } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { ConsoleModel } from "../console";
import { ConsoleView } from "../ConsoleView";
import { updateThreadDump } from "../stackTrace";
import { threadLabel, type DeadlockLink, type DumpThread, type ThreadDump } from "./parse";
import {
  stateCounts,
  threadRows,
  threadStackText,
  visibleThreads,
  type ThreadDumpTab,
  type ThreadRow,
  type ThreadSection,
  type VirtualNote,
} from "./store";
import runStyles from "../Run.module.css";
import styles from "./ThreadDump.module.css";

async function saveDump(tab: ThreadDumpTab) {
  const picked = await saveDialog({
    defaultPath: `${tab.title.replace(/[/\\:*?"<>|]/g, "-")}.txt`,
    filters: [{ name: tx("Text file"), extensions: ["txt"] }],
  });
  if (!picked) return;
  const path = ipcPath(picked);
  try {
    // The save dialog already confirmed replacing the file, and the backend only creates new ones.
    const kind = await call(commands.fsEntryKind(path)).catch(() => null);
    if (kind === "dir") throw new Error(tx`${path} is a directory`);
    if (kind === "file") await call(commands.fsDelete(path));
    await call(commands.fsCreateFileBytes(path, toBase64(new TextEncoder().encode(tab.text))));
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: "Cannot save the thread dump",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

function virtualNoteText(note: VirtualNote): string {
  switch (note) {
    case "noLockOwners":
      return tx("Lock owners of virtual threads need Java 25 or later.");
    case "whileSuspended":
      return tx("Virtual threads are not listed while the debugger stops the program.");
    case "tooLarge":
      return tx("Virtual threads are not listed: there are too many to read.");
    case "failed":
      return tx("Virtual threads are not listed: the JVM could not report them.");
  }
}

function sectionText(row: ThreadSection): string {
  if (row.section === "container") return row.name || tx("Unnamed container");
  const { count } = row;
  return tx`Virtual threads (${count})`;
}

function stackLabel(thread: DumpThread): string {
  const name = threadLabel(thread);
  return tx`Stack of ${name}`;
}

const isSection = (row: ThreadRow): row is ThreadSection => typeof row !== "number";

function DeadlockBanner({ dump, onSelect }: { dump: ThreadDump; onSelect: (name: string) => void }) {
  if (!dump.deadlocks.length) return null;
  const link = ({ thread, waitsFor: lock, heldBy: owner }: DeadlockLink, key: number) => (
    <Fragment key={key}>
      {key > 0 && " → "}
      <button
        type="button"
        className={styles.threadLink}
        title={tx`Waits for ${lock}, held by ${owner}`}
        onClick={() => onSelect(thread)}
      >
        {thread}
      </button>
    </Fragment>
  );
  return (
    <div role="alert" className={styles.banner}>
      {dump.deadlocks.map((cycle, i) => (
        <div key={i} className={styles.cycle}>
          <span className={styles.cycleLabel}>
            <T>Deadlock:</T>
          </span>
          {/* The cycle closes on its first thread. */}
          {[...cycle, ...cycle.slice(0, 1)].map(link)}
        </div>
      ))}
    </div>
  );
}

export function ThreadDumpPanel({ tab }: { tab: ThreadDumpTab }) {
  const root = useProject((s) => s.project?.root ?? "/");
  const { dump, filter, hideJvm, selected, refresh } = tab;
  const shown = useMemo(() => visibleThreads(dump, filter, hideJvm), [dump, filter, hideJvm]);
  const counts = useMemo(() => stateCounts(dump.threads, shown), [dump, shown]);
  const rows = useMemo(() => threadRows(dump.threads, shown), [dump, shown]);
  const thread = selected === null ? undefined : dump.threads[selected];
  const model = useMemo(() => {
    const m = new ConsoleModel();
    if (thread) m.append({ kind: "stdout", text: threadStackText(thread) });
    m.flush();
    return m;
  }, [thread]);
  const [refreshing, setRefreshing] = useState(false);
  const set = (patch: Partial<Pick<ThreadDumpTab, "selected" | "filter" | "hideJvm">>) =>
    updateThreadDump(tab.id, (t) => ({ ...t, ...patch }));
  const selectNamed = (name: string) => {
    const i = dump.threads.findIndex((t) => threadLabel(t) === name);
    if (i >= 0) set({ selected: i });
  };
  const runRefresh = async () => {
    if (!refresh) return;
    setRefreshing(true);
    try {
      await refresh();
    } catch (e) {
      notifications().notify({
        group: "run",
        level: "error",
        title: "Cannot take a new thread dump",
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={styles.root}>
      <DeadlockBanner dump={dump} onSelect={selectNamed} />
      <div className={styles.body}>
        <Toolbar className={runStyles.toolbar} orientation="vertical" aria-label="Thread dump actions">
          <div className={runStyles.toolbarGroup}>
            {tab.source && (
              <IconButton
                icon="refresh"
                title="Refresh"
                disabled={!refresh || refreshing}
                onClick={() => void runRefresh()}
              />
            )}
            <IconButton icon="copy" title="Copy" onClick={() => void writeClipboardText(tab.text)} />
            {/* Like Save Heap Dump As…: local windows only. */}
            {!isRemoteWindow() && <IconButton icon="export" title="Save As…" onClick={() => void saveDump(tab)} />}
          </div>
        </Toolbar>
        <SplitGroup
          orientation="horizontal"
          storageKey="openidea.run.threadDump.split"
          defaultLayout={{ threads: 32, stack: 68 }}
          className={styles.split}
        >
          <SplitPanel id="threads" minSize="160px" className={styles.threads}>
            <div className={styles.listHeader}>
              <SearchField
                className={styles.filter}
                value={filter}
                onChange={(value) => set({ filter: value })}
                placeholder="Filter threads"
                aria-label="Filter threads"
              />
              <IconButton
                icon="filter"
                title="Hide JVM threads"
                pressed={hideJvm}
                onClick={() => set({ hideJvm: !hideJvm })}
              />
            </div>
            <div className={styles.counts} data-testid="thread-state-counts">
              {counts.map(([state, n]) => (
                <span key={state}>{`${state} ${n}`}</span>
              ))}
            </div>
            {tab.virtualNote && (
              <div role="note" className={styles.note}>
                {virtualNoteText(tab.virtualNote)}
              </div>
            )}
            <List
              className={styles.list}
              aria-label={tx("Threads")}
              items={rows}
              getKey={(row) =>
                isSection(row) ? `${row.section}:${row.section === "container" ? row.name : ""}` : String(row)
              }
              isSection={isSection}
              renderSection={(row) =>
                isSection(row) && (
                  <span className={row.section === "container" ? styles.container : undefined}>{sectionText(row)}</span>
                )
              }
              activeIndex={selected === null ? -1 : rows.indexOf(selected)}
              onActiveChange={(i) => {
                const row = rows[i];
                set({ selected: typeof row === "number" ? row : null });
              }}
              renderItem={(row) => {
                if (isSection(row)) return null;
                const t = dump.threads[row]!;
                const state = t.state === "UNKNOWN" ? tx("State unknown") : t.state;
                return (
                  <>
                    <Icon name={t.state === "RUNNABLE" ? "thread-running" : "thread-suspended"} label={state} />
                    <span className={styles.name} title={t.stateDetail ? `${state} (${t.stateDetail})` : state}>
                      {threadLabel(t)}
                    </span>
                    {t.deadlocked && <span className={styles.deadlockMark} role="img" aria-label={tx("Deadlocked")} />}
                  </>
                );
              }}
            />
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="stack" minSize="200px" className={styles.stack}>
            <ConsoleView
              key={selected ?? -1}
              model={model}
              version={model.size}
              softWrap={false}
              follow={false}
              onFollowChange={() => {}}
              cwd={root}
              aria-label={thread ? stackLabel(thread) : tx("Thread stack")}
            />
          </SplitPanel>
        </SplitGroup>
      </div>
    </div>
  );
}
