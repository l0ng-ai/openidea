/**
 * Python Packages tool window: the packages of the project's interpreter, a PyPI project
 * looked up by exact name, and install / upgrade / uninstall through pip or uv.
 */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId, type PypiPackage, type PythonPackage } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { usePythonPackages } from "@/platform/pythonPackages";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Input,
  List,
  Select,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
} from "@/ui";
import { isPackageName, listRows, normalize, requirementOf, rowKey, type Row } from "./model";
import styles from "./PythonPackages.module.css";

type Op = "install" | "upgrade" | "uninstall";

interface Job {
  op: Op;
  target: string;
  cancel: () => void;
}

const message = (e: unknown) => String((e as Error)?.message ?? e);

/** The interpreter whose packages are listed; a run target's (`container`) is read-only. */
function useInterpreter() {
  const root = useProject((s) => s.project?.root ?? null);
  const setting = useProject((s) => s.settings?.languages?.python?.interpreter ?? "");
  const container = setting.trim().startsWith("target:");
  const key = `${root}\n${setting}`;
  const [local, setLocal] = useState<{ key: string; python: string | null } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; packages: PythonPackage[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!root) return;
    let live = true;
    if (container) {
      call(commands.sdkContainerPython()).then(
        (info) => live && setSnapshot({ key, packages: info?.packages ?? [] }),
        () => live && setSnapshot({ key, packages: [] }),
      );
    } else {
      call(commands.sdkPythonEffective(null)).then(
        (python) => live && setLocal({ key, python }),
        () => live && setLocal({ key, python: null }),
      );
    }
    return () => {
      live = false;
    };
  }, [root, container, key, tick]);
  return {
    container,
    python: !container && local?.key === key ? local.python : null,
    snapshot: container && snapshot?.key === key ? snapshot.packages : null,
    resolved: container ? snapshot?.key === key : local?.key === key,
    retry: () => setTick((t) => t + 1),
  };
}

/** The PyPI project named exactly `name`, asked `delay` ms after the name last changed. */
function usePypi(name: string | null, delay: number) {
  const [state, setState] = useState<{ name: string; found: PypiPackage | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!name) return;
    let live = true;
    let running = false;
    const request = nextRequestId();
    const timer = setTimeout(() => {
      running = true;
      call(commands.pypiPackage(name, request))
        .then(
          (found) => live && setState({ name, found, error: null }),
          (e: unknown) => live && !isCancelled(e) && setState({ name, found: null, error: message(e) }),
        )
        .finally(() => (running = false));
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
      if (running) void commands.cancelRequest(request);
    };
  }, [name, delay]);
  const current = name && state?.name === name ? state : null;
  return { found: current?.found ?? null, error: current?.error ?? null, loading: !!name && !current };
}

export function PackagesView() {
  const { container, python, snapshot, resolved, retry } = useInterpreter();
  const local = usePythonPackages(python);
  const packages = container ? snapshot : local.packages;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);

  const name = query.trim();
  const search = usePypi(!container && isPackageName(name) ? name : null, 300);
  const rows = useMemo(
    () => listRows(packages ?? [], local.newer, search.found, query),
    [packages, local.newer, search.found, query],
  );
  // By name, so a package stays selected when installing it moves it out of the PyPI section.
  const active = rows.findIndex((r) => r.kind !== "section" && normalize(r.name) === selected);
  const row = rows[active];
  const picked = row && row.kind !== "section" ? row : null;
  // The search already asked PyPI about the package it found.
  const fromSearch = !!picked && !!search.found && normalize(search.found.name) === normalize(picked.name);
  const details = usePypi(picked && !container && !fromSearch ? picked.name : null, 0);
  const info = fromSearch ? search : details;

  const run = (op: Op, requirement: string) => {
    if (!python || job) return;
    const request = nextRequestId();
    const channel = new Channel<string>();
    channel.onmessage = (line) => setLog((l) => [...l.slice(-400), line]);
    setLog([]);
    setJobError(null);
    setJob({ op, target: requirement, cancel: () => void commands.cancelRequest(request) });
    call(commands.sdkPythonPip(python, requirement, op === "uninstall", op === "upgrade", request, channel))
      .then(local.reload, (e: unknown) => setJobError(isCancelled(e) ? null : message(e)))
      .finally(() => setJob(null));
  };

  if (resolved && !container && !python) {
    return (
      <EmptyState
        title="No Python interpreter"
        actions={
          <>
            <Button onClick={() => void executeAction("python.interpreterSettings")}>
              <T>Interpreter Settings…</T>
            </Button>
            <Button onClick={retry}>
              <T>Retry</T>
            </Button>
          </>
        }
      >
        <T>Select an interpreter for this project to manage its packages.</T>
      </EmptyState>
    );
  }

  const loading = !resolved || local.loading;
  return (
    <SplitGroup orientation="horizontal" id="python-packages-split" storageKey="openidea.pythonPackages.split">
      <SplitPanel id="list" minSize={220} defaultSize="35%" className={styles.listPane}>
        <div className={styles.toolbar}>
          <Input
            className={styles.search}
            value={query}
            placeholder="Search installed packages or type a PyPI package name"
            aria-label="Search packages"
            onChange={(e) => setQuery(e.target.value)}
          />
          <IconButton
            icon="refresh"
            size="small"
            title="Reload List of Packages"
            disabled={loading || !!job}
            onClick={container ? retry : local.reload}
          />
          {(loading || local.checking || search.loading) && (
            <Spinner
              size={14}
              label={loading ? "Loading packages" : search.loading ? "Searching PyPI" : "Checking for newer versions"}
            />
          )}
        </div>
        {local.error ? (
          <div className={styles.error} role="alert">
            {local.error}
          </div>
        ) : (
          <List<Row>
            items={rows}
            getKey={rowKey}
            isSection={(r) => r.kind === "section"}
            activeIndex={active}
            onActiveChange={(i) => {
              const r = rows[i];
              setSelected(r && r.kind !== "section" ? normalize(r.name) : null);
            }}
            aria-label="Python packages"
            className={styles.list}
            empty={
              <span>
                {loading ? (
                  <T>Loading packages…</T>
                ) : search.loading ? (
                  <T>Searching PyPI…</T>
                ) : name ? (
                  <T>No packages match</T>
                ) : (
                  <T>No packages installed</T>
                )}
              </span>
            }
            renderSection={(r) => (r.kind === "section" && r.id === "installed" ? <T>Installed</T> : "PyPI")}
            renderItem={(r) =>
              r.kind === "section" ? null : (
                <span className={styles.row}>
                  <span className={styles.name}>{r.name}</span>
                  {r.kind === "installed" && <span className={styles.version}>{r.version}</span>}
                  {r.latest && (
                    <span
                      className={r.kind === "installed" ? styles.upgradable : styles.version}
                      title={r.kind === "installed" ? tx`Upgrade available: ${r.latest}` : undefined}
                    >
                      {r.kind === "installed" && <Icon name="arrow-up" size={12} />}
                      {r.latest}
                    </span>
                  )}
                </span>
              )
            }
          />
        )}
        {local.checkFailed && (
          <div className={styles.note}>
            <T>Could not check for newer versions of the packages.</T>
          </div>
        )}
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="details" minSize={260} className={styles.detailsPane}>
        {picked ? (
          <Details key={rowKey(picked)} row={picked} info={info} readOnly={container} busy={!!job} run={run} />
        ) : (
          <EmptyState>
            <T>Select a package to see its versions.</T>
          </EmptyState>
        )}
        {container && (
          <div className={styles.note}>
            <T>Packages come from the container image and are read-only here.</T>
          </div>
        )}
        {job && (
          <div className={styles.status}>
            <Spinner size={14} label="Working" />
            <span>
              {job.op === "install" ? tx("Installing") : job.op === "upgrade" ? tx("Upgrading") : tx("Uninstalling")}{" "}
              {job.target}…
            </span>
            <Button size="small" variant="ghost" onClick={job.cancel}>
              <T>Cancel</T>
            </Button>
          </div>
        )}
        {jobError && (
          <div className={styles.error} role="alert">
            {jobError}
          </div>
        )}
        {log.length > 0 && (
          <pre className={styles.log} aria-label={tx("pip output")} tabIndex={0}>
            {log.join("\n")}
          </pre>
        )}
      </SplitPanel>
    </SplitGroup>
  );
}

function Details({
  row,
  info,
  readOnly,
  busy,
  run,
}: {
  row: Exclude<Row, { kind: "section" }>;
  info: { found: PypiPackage | null; error: string | null; loading: boolean };
  readOnly: boolean;
  busy: boolean;
  run: (op: Op, requirement: string) => void;
}) {
  const installed = row.kind === "installed" ? row.version : null;
  const versions = info.found?.versions;
  const [choice, setChoice] = useState<string | null>(null);
  // The installed version, else the newest release; a pre-release only when nothing else exists.
  const preset = installed ?? (info.found?.latest || versions?.[0]) ?? null;
  const version = choice ?? preset;
  const options = useMemo(() => {
    const all = versions ?? [];
    return (version && !all.includes(version) ? [version, ...all] : all).map((v) => ({
      value: v,
      label: v,
      verbatim: true,
    }));
  }, [versions, version]);

  return (
    <div className={styles.details}>
      <div className={styles.title}>
        <span className={styles.packageName}>{row.name}</span>
        <span className={styles.version}>{installed ?? <T>Not installed</T>}</span>
      </div>
      {info.found?.summary && <div className={styles.summary}>{info.found.summary}</div>}
      {info.loading && (
        <div className={styles.note}>
          <T>Loading package information from PyPI…</T>
        </div>
      )}
      {info.error && (
        <div className={styles.note}>
          <T>Could not load package information from PyPI.</T>
        </div>
      )}
      {!readOnly && !info.loading && !info.error && !info.found && (
        <div className={styles.note}>
          <T>This package is not on PyPI.</T>
        </div>
      )}
      {!readOnly && (
        <div className={styles.actions}>
          {options.length > 0 && version && (
            <Select
              className={styles.versions}
              value={version}
              options={options}
              onChange={setChoice}
              disabled={busy}
              searchable
              aria-label="Version"
            />
          )}
          {installed === null ? (
            <Button
              size="small"
              variant="primary"
              disabled={busy || info.loading}
              // Left at the preset, pip picks the newest release this interpreter can install.
              onClick={() => run("install", requirementOf(row.name, choice))}
            >
              <T>Install</T>
            </Button>
          ) : (
            <>
              <Button
                size="small"
                disabled={busy || !choice || choice === installed}
                onClick={() => run("install", requirementOf(row.name, choice))}
              >
                <T>Install Version</T>
              </Button>
              {row.latest && (
                <Button size="small" variant="primary" disabled={busy} onClick={() => run("upgrade", row.name)}>
                  {tx`Upgrade to ${row.latest}`}
                </Button>
              )}
              <Button size="small" disabled={busy} onClick={() => run("uninstall", row.name)}>
                <T>Uninstall</T>
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
