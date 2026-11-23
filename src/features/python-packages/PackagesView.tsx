/**
 * Python Packages tool window: the packages of the project's interpreter, a PyPI project
 * looked up by exact name, and install / upgrade / uninstall through pip or uv.
 */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { call, commands, isCancelled, nextRequestId, type PypiPackage, type PythonPackage } from "@/platform/ipc";
import { dirname, useProject } from "@/platform/project";
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
import { editorService } from "@/workbench/contributions";
import { isPackageName, listRows, normalize, requirementOf, rowKey, type Row } from "./model";
import styles from "./PythonPackages.module.css";

type Op = "install" | "upgrade" | "uninstall";

interface Job {
  op: Op;
  target: string;
  cancel: () => void;
}

const message = (e: unknown) => String((e as Error)?.message ?? e);

/** The folder of the active editor's file, which picks the interpreter as runs do. */
function useActiveFolder() {
  const folder = () => {
    const path = editorService().activePath();
    return path ? dirname(path) : null;
  };
  const [current, setCurrent] = useState(folder);
  useEffect(() => editorService().onActiveInputChange?.(() => setCurrent(folder())), []);
  return current;
}

/**
 * The interpreter whose packages are listed: the one runs and the Python Console use for the
 * active file (in a workspace, its member's virtualenv). A run target's (`container`) is read-only.
 */
function useInterpreter() {
  const root = useProject((s) => s.project?.root ?? null);
  const setting = useProject((s) => s.settings?.languages?.python?.interpreter ?? "");
  const near = useActiveFolder();
  const container = setting.trim().startsWith("target:");
  const key = `${root}\n${setting}\n${near}`;
  const [local, setLocal] = useState<{ key: string; python: string | null } | null>(null);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    packages: PythonPackage[];
    updating: boolean;
    error: string | null;
  } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!root) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (container) {
      const load = () =>
        call(commands.sdkContainerPython()).then(
          (info) => {
            if (!live) return;
            setSnapshot({ key, packages: info?.packages ?? [], updating: !!info?.updating, error: null });
            if (info?.updating) timer = setTimeout(load, 2000);
          },
          (e: unknown) => live && setSnapshot({ key, packages: [], updating: false, error: message(e) }),
        );
      void load();
    } else {
      call(commands.sdkPythonEffective(near)).then(
        (python) => live && setLocal({ key, python }),
        () => live && setLocal({ key, python: null }),
      );
    }
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [root, container, near, key, tick]);
  return {
    root,
    container,
    python: !container && local?.key === key ? local.python : null,
    snapshot: container && snapshot?.key === key ? snapshot : null,
    resolved: container ? snapshot?.key === key : local?.key === key,
    retry: () => setTick((t) => t + 1),
  };
}

/** A package index other than PyPI configured for `python`'s pip or uv; `undefined` until known. */
function useCustomIndex(python: string | null) {
  const [state, setState] = useState<{ python: string; index: string | null } | null>(null);
  useEffect(() => {
    if (!python) return;
    let live = true;
    const request = nextRequestId();
    call(commands.sdkPythonPackageIndex(python, request)).then(
      (index) => live && setState({ python, index }),
      // Unknown counts as custom: names stay on this machine.
      () => live && setState({ python, index: "" }),
    );
    return () => {
      live = false;
      void commands.cancelRequest(request);
    };
  }, [python]);
  return python && state?.python === python ? state.index : undefined;
}

/** PyPI projects looked up this session, by normalised name; `null` when PyPI has none. */
const pypiCache = new Map<string, PypiPackage | null>();

/** The PyPI project named exactly `name`, asked `delay` ms after the name last changed. */
function usePypi(name: string | null, delay: number) {
  const [state, setState] = useState<{ name: string; error: string } | null>(null);
  const [, setDone] = useState(0);
  const [tick, setTick] = useState(0);
  const cached = name ? pypiCache.get(normalize(name)) : undefined;
  useEffect(() => {
    if (!name || pypiCache.has(normalize(name))) return;
    let live = true;
    let running = false;
    const request = nextRequestId();
    const timer = setTimeout(() => {
      running = true;
      call(commands.pypiPackage(name, request))
        .then(
          (found) => {
            pypiCache.set(normalize(name), found);
            if (live) setDone((n) => n + 1);
          },
          (e: unknown) => live && !isCancelled(e) && setState({ name, error: message(e) }),
        )
        .finally(() => (running = false));
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
      if (running) void commands.cancelRequest(request);
    };
  }, [name, delay, tick]);
  const error = name && cached === undefined && state?.name === name ? state.error : null;
  return {
    found: cached ?? null,
    error,
    loading: !!name && cached === undefined && !error,
    retry: () => {
      setState(null);
      setTick((t) => t + 1);
    },
  };
}

export function PackagesView() {
  const tx = useTx();
  const { root, container, python, snapshot, resolved, retry } = useInterpreter();
  const local = usePythonPackages(python);
  const customIndex = useCustomIndex(python);
  // Names go to pypi.org on their own only when installing uses PyPI too.
  const auto = customIndex === null;
  const [asked, setAsked] = useState<string | null>(null);
  const [detailsOf, setDetailsOf] = useState<string | null>(null);
  const packages = container ? snapshot?.packages : local.packages;
  const error = container ? snapshot?.error : local.error;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);

  const name = query.trim();
  const searchable = !container && isPackageName(name);
  const search = usePypi(searchable && (auto || asked === name) ? name : null, 300);
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
  // An installed package's name is sent to PyPI only when asked for: it may be a private one.
  const wanted = !!picked && (picked.kind === "pypi" || detailsOf === normalize(picked.name));
  const details = usePypi(picked && !container && !fromSearch && wanted ? picked.name : null, 200);
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
      .catch((e: unknown) => setJobError(isCancelled(e) ? null : message(e)))
      .finally(() => {
        setJob(null);
        // A failed or cancelled run can still have installed some of the packages.
        local.reload();
      });
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

  const loading = !resolved || local.loading || !!snapshot?.updating;
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
          {python && (
            <span className={styles.interpreter} title={python}>
              {relativeTo(root, python)}
            </span>
          )}
          {(loading || local.checking || search.loading) && (
            <Spinner
              size={14}
              label={tx(
                loading ? "Loading packages" : search.loading ? "Searching PyPI" : "Checking for newer versions",
              )}
            />
          )}
        </div>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
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
            aria-label={tx("Python packages")}
            className={styles.list}
            empty={
              !search.error && (
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
              )
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
        {searchable && !auto && customIndex !== undefined && asked !== name && (
          <div className={styles.note}>
            <span>
              <T>Installing uses another package index, so names are not sent to PyPI on their own.</T>
            </span>{" "}
            <Button size="small" variant="ghost" onClick={() => setAsked(name)}>
              {tx`Search PyPI for ${name}`}
            </Button>
          </div>
        )}
        {search.error && (
          <div className={styles.note} role="alert">
            <span>
              <T>Could not load package information from PyPI.</T>
            </span>{" "}
            <Button size="small" variant="ghost" onClick={search.retry}>
              <T>Retry</T>
            </Button>
          </div>
        )}
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="details" minSize={260} className={styles.detailsPane}>
        {picked ? (
          <Details
            key={rowKey(picked)}
            row={picked}
            info={info}
            asked={wanted || fromSearch}
            onAsk={() => setDetailsOf(normalize(picked.name))}
            readOnly={container}
            busy={!!job || loading}
            run={run}
          />
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
            <Spinner size={14} label={tx("Working")} />
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

/** `path` relative to `root` when it is inside it. */
function relativeTo(root: string | null, path: string) {
  const base = root?.replace(/[\\/]+$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function Details({
  row,
  info,
  asked,
  onAsk,
  readOnly,
  busy,
  run,
}: {
  row: Exclude<Row, { kind: "section" }>;
  info: { found: PypiPackage | null; error: string | null; loading: boolean; retry: () => void };
  /** Whether PyPI was asked about this package. */
  asked: boolean;
  onAsk: () => void;
  readOnly: boolean;
  busy: boolean;
  run: (op: Op, requirement: string) => void;
}) {
  const tx = useTx();
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
      {!readOnly && !asked && (
        <div>
          <Button size="small" onClick={onAsk}>
            <T>Show PyPI Details</T>
          </Button>
        </div>
      )}
      {asked && info.loading && (
        <div className={styles.note}>
          <T>Loading package information from PyPI…</T>
        </div>
      )}
      {asked && info.error && (
        <div className={styles.note} role="alert">
          <span>
            <T>Could not load package information from PyPI.</T>
          </span>{" "}
          <Button size="small" variant="ghost" onClick={info.retry}>
            <T>Retry</T>
          </Button>
        </div>
      )}
      {!readOnly && asked && !info.loading && !info.error && !info.found && (
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
