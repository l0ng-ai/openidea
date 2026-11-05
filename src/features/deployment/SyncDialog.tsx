/** Deployment directory diff: mirrored file lists above an embedded content diff. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import clsx from "clsx";
import type { SyncEntry, SyncStatus, SyncStep } from "@/platform/ipc";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import {
  Dialog,
  DialogButtons,
  Icon,
  IconButton,
  Input,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  fileIconName,
  type DialogProps,
} from "@/ui";
import { TitleBar } from "@/workbench/TitleBar";
import { usePlatform } from "@/platform/platformInfo";
import { closeSync, openSync, runSync, type SyncRunMode } from "./actions";
import { createDeploymentComparison, type DeploymentComparison } from "./comparison";
import { defaultSyncAction, formatSize, formatTime, syncChoices, syncSteps, type SyncChoice } from "./model";
import { patchSync, useDeployment, type SyncDialogState } from "./store";
import { SyncPreview } from "./SyncPreview";
import styles from "./Deployment.module.css";

const STATUS: Record<SyncStatus, string> = {
  localOnly: "Local only",
  remoteOnly: "Remote only",
  localNewer: "Local is newer",
  remoteNewer: "Remote is newer",
  different: "Contents differ",
  same: "Identical",
};
const CHOICES: Record<SyncChoice, [string, string]> = {
  skip: ["—", "Skip"],
  upload: ["→", "Upload"],
  download: ["←", "Download"],
  deleteRemote: ["× →", "Delete remote"],
  deleteLocal: ["← ×", "Delete local"],
};
type CompareBy = "metadata" | "content";
const NO_VERIFIED: Record<string, boolean> = {};
const NO_ERRORS: Record<string, string> = {};
interface ContentScan {
  comparison: DeploymentComparison;
  entries: SyncEntry[];
  verified: Record<string, boolean>;
  errors: Record<string, string>;
  progress: number | null;
}

function ComparisonFrame({ standalone, ...props }: DialogProps & { standalone: boolean }) {
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  if (!standalone) return <Dialog {...props} />;
  return (
    <section className={styles.nativeWindow} aria-label={typeof props.title === "string" ? props.title : undefined}>
      {ownTitleBar && <TitleBar minimal title={props.title as string} />}
      <div className={styles.nativeBody}>{props.children}</div>
      <footer className={styles.nativeFooter}>
        {props.footerStart as ReactNode}
        <DialogButtons buttons={props.buttons ?? []} onCancel={props.onClose} />
      </footer>
    </section>
  );
}

function SyncComparison({
  sync,
  standalone,
  beforeSynchronize,
}: {
  sync: SyncDialogState;
  standalone: boolean;
  beforeSynchronize?: (steps: SyncStep[]) => Promise<void>;
}) {
  const root = useProject((s) => s.project?.root ?? null);
  const server = useWorkflowSettings((s) => s.deployment.servers.find((item) => item.id === sync.server));
  const tx = useTx();
  const txt = useTxTemplate();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showLocal, setShowLocal] = useState(true);
  const [showDifferent, setShowDifferent] = useState(true);
  const [showRemote, setShowRemote] = useState(true);
  const [compareBy, setCompareBy] = useState<CompareBy>("metadata");
  const [scan, setScan] = useState<ContentScan | null>(null);
  const [generation, setGeneration] = useState(0);
  const touched = useRef(new Set<string>());
  const synchronizing = useRef(false);
  const comparison = useMemo(
    () => (server && root ? { ...createDeploymentComparison(server, root), generation, entries: sync.entries } : null),
    [server, root, generation, sync.entries],
  );
  const entries = sync.entries;
  const activeScan =
    compareBy === "content" && scan?.comparison === comparison && scan.entries === entries ? scan : null;
  const verified = activeScan?.verified ?? NO_VERIFIED;
  const checkErrors = activeScan?.errors ?? NO_ERRORS;
  const progress = compareBy === "content" && entries && comparison ? (activeScan ? activeScan.progress : 0) : null;
  const changeCompareBy = (mode: CompareBy) => {
    setScan(null);
    setCompareBy(mode);
  };

  useEffect(() => {
    const abort = new AbortController();
    if (!entries || !comparison) return;
    const suggest = (entry: SyncEntry, status: SyncStatus) => {
      const current = useDeployment.getState().sync;
      if (current?.entries !== entries || touched.current.has(entry.path)) return;
      patchSync({ choices: { ...current.choices, [entry.path]: defaultSyncAction(status) } });
    };
    if (compareBy === "metadata") {
      entries.forEach((entry) => suggest(entry, entry.status));
      return;
    }
    void (async () => {
      await Promise.resolve();
      const verified: Record<string, boolean> = {};
      const errors: Record<string, string> = {};
      for (let i = 0; i < entries.length; i++) {
        if (abort.signal.aborted) return;
        const entry = entries[i]!;
        try {
          if (entry.local && entry.remote) {
            const equal = await comparison.equal(entry, abort.signal);
            if (abort.signal.aborted) return;
            verified[entry.path] = equal;
            suggest(entry, equal ? "same" : entry.status === "same" ? "different" : entry.status);
          }
        } catch (e) {
          if (abort.signal.aborted) return;
          errors[entry.path] = e instanceof Error ? e.message : String(e);
        }
        if (abort.signal.aborted) return;
        setScan({ comparison, entries, verified: { ...verified }, errors: { ...errors }, progress: i + 1 });
      }
      if (!abort.signal.aborted) setScan({ comparison, entries, verified, errors, progress: null });
    })();
    return () => abort.abort();
  }, [entries, comparison, compareBy]);

  const compared = useMemo(
    () =>
      entries?.map((entry) =>
        verified[entry.path] === undefined
          ? entry
          : {
              ...entry,
              status: verified[entry.path] ? ("same" as const) : ("different" as const),
            },
      ) ?? [],
    [entries, verified],
  );
  const shown = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return compared.filter(
      (entry) =>
        entry.path.toLocaleLowerCase().includes(query) &&
        (checkErrors[entry.path] ||
          (entry.status === "same"
            ? !sync.hideSame
            : entry.status === "localOnly"
              ? showLocal
              : entry.status === "remoteOnly"
                ? showRemote
                : showDifferent)),
    );
  }, [compared, filter, checkErrors, sync.hideSame, showLocal, showRemote, showDifferent]);
  const selected = shown.find((entry) => entry.path === selectedPath) ?? shown[0] ?? null;
  const previewEntry = entries?.find((entry) => entry.path === selected?.path) ?? null;
  const steps = syncSteps(sync.choices);
  const selectedSteps = steps.filter((step) => step.path === selected?.path);
  const busy = sync.running || !entries || progress !== null;
  const synchronize = async (mode: SyncRunMode) => {
    const selectedOperations = mode === "selected" ? selectedSteps : steps;
    if (busy || synchronizing.current || !selectedOperations.length) return;
    synchronizing.current = true;
    if (mode === "selected") selectedOperations.forEach((step) => touched.current.add(step.path));
    try {
      if (beforeSynchronize) {
        patchSync({ running: true });
        await beforeSynchronize(selectedOperations);
        if (useDeployment.getState().sync?.paths !== sync.paths) return;
      }
      const report = await (mode === "selected" ? runSync(selectedOperations, mode) : runSync(selectedOperations));
      if (mode === "selected" && report?.files && !report.errors.length && !report.skipped) {
        const index = shown.findIndex((entry) => entry.path === selected?.path);
        const choices = useDeployment.getState().sync?.choices;
        const next = [...shown.slice(index + 1), ...shown.slice(0, index)].find(
          (entry) => choices?.[entry.path] && choices[entry.path] !== "skip",
        );
        if (next) setSelectedPath((current) => (current === selectedPath ? next.path : current));
      }
    } catch (error) {
      if (useDeployment.getState().sync?.paths === sync.paths)
        patchSync({ running: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      synchronizing.current = false;
    }
  };
  const choose = (entry: SyncEntry, choice: SyncChoice) => {
    if (sync.running) return;
    touched.current.add(entry.path);
    setSelectedPath(entry.path);
    patchSync({ choices: { ...useDeployment.getState().sync?.choices, [entry.path]: choice } });
  };
  const onTableKey = (event: KeyboardEvent<HTMLTableElement>) => {
    if ((event.target as HTMLElement).closest("select, button, input")) return;
    const index = shown.findIndex((entry) => entry.path === selected?.path);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        setSelectedPath(next.path);
        document.getElementById(`deploy-row-${shown.indexOf(next)}`)?.scrollIntoView({ block: "nearest" });
      }
    } else if (
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void synchronize("selected");
    } else if (event.key === " " && selected && !busy) {
      event.preventDefault();
      const choices = syncChoices(selected);
      choose(selected, choices[(choices.indexOf(sync.choices[selected.path] ?? "skip") + 1) % choices.length]!);
    }
  };
  const refresh = () => {
    if (!server || busy) return;
    touched.current.clear();
    setGeneration((n) => n + 1);
    void openSync(server, sync.paths);
  };

  return (
    <ComparisonFrame
      standalone={standalone}
      open
      title={txt(`Diff Between 'local files' and 'files on ${sync.serverName}'`)}
      onClose={standalone ? () => void getCurrentWebviewWindow().close() : closeSync}
      width="calc(100vw - 48px)"
      className={styles.syncWindow}
      resizable="both"
      footerStart={
        <span className={styles.note}>{entries && txt(`${steps.length} of ${entries.length} files will change`)}</span>
      }
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "Synchronize All",
          role: "extra",
          disabled: busy || steps.length === 0,
          onClick: () => void synchronize("all"),
        },
      ]}
    >
      <div className={styles.sync}>
        <div className={styles.comparisonToolbar} role="toolbar" aria-label={tx("Deployment comparison options")}>
          <IconButton
            icon="refresh"
            title="Refresh comparison"
            size="small"
            disabled={busy || !server}
            onClick={refresh}
          />
          <span className={styles.separator} />
          <button
            className={styles.filterButton}
            aria-label={tx("Show local-only files")}
            aria-pressed={showLocal}
            onClick={() => setShowLocal(!showLocal)}
          >
            →
          </button>
          <button
            className={styles.filterButton}
            aria-label={tx("Show different files")}
            aria-pressed={showDifferent}
            onClick={() => setShowDifferent(!showDifferent)}
          >
            ≠
          </button>
          <button
            className={styles.filterButton}
            aria-label={tx("Show identical files")}
            aria-pressed={!sync.hideSame}
            onClick={() => patchSync({ hideSame: !sync.hideSame })}
          >
            =
          </button>
          <button
            className={styles.filterButton}
            aria-label={tx("Show remote-only files")}
            aria-pressed={showRemote}
            onClick={() => setShowRemote(!showRemote)}
          >
            ←
          </button>
          <span className={styles.separator} />
          <label className={styles.compareBy}>
            <T>Compare by:</T>
            <select
              aria-label={tx("Compare by")}
              value={compareBy}
              disabled={sync.running}
              onChange={(e) => changeCompareBy(e.target.value as CompareBy)}
            >
              <option value="metadata">{tx("Size and Timestamp")}</option>
              <option value="content">{tx("Binary Content")}</option>
            </select>
          </label>
          <span className={styles.separator} />
          <IconButton
            icon="run"
            title="Synchronize Selected"
            shortcut="Enter"
            size="small"
            disabled={busy || !selectedSteps.length}
            onClick={() => void synchronize("selected")}
          />
          {progress !== null && (
            <>
              <Spinner size={14} />
              <span className={styles.note} role="status">
                {txt(`Comparing contents: ${progress} of ${entries?.length ?? 0}`)}
              </span>
              <IconButton
                icon="stop"
                title="Stop content comparison"
                size="small"
                onClick={() => changeCompareBy("metadata")}
              />
            </>
          )}
          <label className={styles.fileFilter}>
            <T>Filter:</T>
            <Input aria-label={tx("Filter by name")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        </div>
        <div className={styles.comparisonRoots}>
          <span title={root ?? ""}>
            <Icon name="folder" size={14} />
            <span>{root ?? tx("Local files")}</span>
          </span>
          <span title={server?.rootPath}>
            <Icon name="web" size={14} />
            <span>
              {sync.serverName}: {server?.rootPath || "/"}
            </span>
          </span>
        </div>
        {sync.error && (
          <div className={styles.error} role="alert">
            {sync.error}
          </div>
        )}
        {!!sync.skipped?.length && (
          <div className={styles.note}>
            {txt(`Skipped: ${sync.skipped.length}`)}: {sync.skipped.map((item) => item.path).join(", ")}
          </div>
        )}
        {!entries && !sync.error && (
          <div className={styles.center} role="status">
            <Spinner />
            <T>Comparing local and remote files…</T>
          </div>
        )}
        {sync.running && (
          <div className={styles.center} role="status">
            <Spinner size={14} />
            <T>Synchronizing…</T>
          </div>
        )}
        {entries && (
          <SplitGroup orientation="vertical" className={styles.comparisonSplit}>
            <SplitPanel defaultSize="32%" minSize="100px">
              <div className={styles.fileList}>
                <div className={styles.syncTableHost}>
                  <table
                    className={styles.syncTable}
                    role="grid"
                    tabIndex={0}
                    aria-label={tx("Files to synchronize")}
                    aria-activedescendant={selected ? `deploy-row-${shown.indexOf(selected)}` : undefined}
                    onKeyDown={onTableKey}
                  >
                    <colgroup>
                      <col />
                      <col className={styles.sizeCol} />
                      <col className={styles.timeCol} />
                      <col className={styles.operationCol} />
                      <col className={styles.timeCol} />
                      <col className={styles.sizeCol} />
                      <col />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>{tx("Local name")}</th>
                        <th>{tx("Size")}</th>
                        <th>{tx("Date")}</th>
                        <th aria-label={tx("Action")}>↔</th>
                        <th>{tx("Date")}</th>
                        <th>{tx("Size")}</th>
                        <th>{tx("Remote name")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!shown.length && (
                        <tr>
                          <td colSpan={7} className={styles.emptyCell}>
                            <T>No matching differences</T>
                          </td>
                        </tr>
                      )}
                      {shown.map((entry, index) => (
                        <tr
                          key={entry.path}
                          id={`deploy-row-${index}`}
                          aria-selected={selected?.path === entry.path}
                          className={clsx(
                            styles[`status-${entry.status}`],
                            sync.choices[entry.path] === "skip" && styles.skipped,
                          )}
                          onClick={(event) => {
                            setSelectedPath(entry.path);
                            if (!(event.target as HTMLElement).closest("select, button, input"))
                              event.currentTarget.closest("table")?.focus({ preventScroll: true });
                          }}
                        >
                          <td title={entry.local && root ? `${root}/${entry.path}` : tx("(does not exist)")}>
                            {entry.local && (
                              <span className={styles.fileName}>
                                <Icon name={fileIconName(entry.path)} size={14} />
                                {entry.path}
                              </span>
                            )}
                          </td>
                          <td className={styles.num}>{entry.local ? formatSize(entry.local.size) : ""}</td>
                          <td>{formatTime(entry.local?.mtime)}</td>
                          <td className={styles.operationCell}>
                            <select
                              className={styles.choice}
                              aria-label={`${tx("Action")} ${entry.path}`}
                              title={checkErrors[entry.path] ?? tx(STATUS[entry.status])}
                              value={sync.choices[entry.path] ?? "skip"}
                              disabled={busy}
                              onChange={(e) => choose(entry, e.target.value as SyncChoice)}
                            >
                              {syncChoices(entry).map((choice) => (
                                <option key={choice} value={choice} title={tx(CHOICES[choice][1])}>
                                  {CHOICES[choice][0]} {tx(CHOICES[choice][1])}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>{formatTime(entry.remote?.mtime)}</td>
                          <td className={styles.num}>{entry.remote ? formatSize(entry.remote.size) : ""}</td>
                          <td title={entry.remotePath}>
                            {entry.remote && (
                              <span className={styles.fileName}>
                                <Icon name={fileIconName(entry.path)} size={14} />
                                {entry.path}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={styles.listHint}>
                  <T>
                    Space changes the selected operation. Enter synchronizes the selected file. Synchronize All applies
                    all chosen operations.
                  </T>
                </div>
              </div>
            </SplitPanel>
            <SplitHandle aria-label={tx("Resize file list and diff preview")} />
            <SplitPanel defaultSize="68%" minSize="160px">
              {selected && checkErrors[selected.path] && (
                <div className={styles.error} role="alert">
                  {checkErrors[selected.path]}
                </div>
              )}
              {comparison ? (
                <SyncPreview key={selected?.path ?? "empty"} entry={previewEntry} comparison={comparison} />
              ) : (
                <div className={styles.center}>
                  <T>The deployment server or project is no longer available</T>
                </div>
              )}
            </SplitPanel>
          </SplitGroup>
        )}
      </div>
    </ComparisonFrame>
  );
}

export function SyncDialog({
  standalone = false,
  beforeSynchronize,
}: {
  standalone?: boolean;
  beforeSynchronize?: (steps: SyncStep[]) => Promise<void>;
}) {
  const sync = useDeployment((s) => s.sync);
  return sync ? <SyncComparison sync={sync} standalone={standalone} beforeSynchronize={beforeSynchronize} /> : null;
}
