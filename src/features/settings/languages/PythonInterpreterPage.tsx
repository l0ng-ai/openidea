/**
 * Settings › Python › Interpreter (PyCharm's "Python Interpreter" page): the
 * project interpreter and its packages (pip / uv pip). The interpreter feeds
 * run configurations, basedpyright / pyright (`python.pythonPath`) and the
 * terminal's virtualenv activation. A Docker or Compose run target can be the
 * interpreter (`target:<id>`): its libraries are a read-only snapshot of the image.
 */
import { isCancelled } from "@/platform/ipc";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { Button, IconButton, Input, Spinner, showContextMenu, T, type SelectOption } from "@/ui";
import { useProject } from "@/platform/project";
import { DOCSTRING_FORMATS, type DocstringFormat } from "@/platform/editorSettings";
import { Section, SettingSelect, Toggle } from "../components/Form";
import {
  containerPython,
  effectivePython,
  interpreterTarget,
  listPackages,
  pip,
  refreshContainerPython,
  targetChoices,
  useSdks,
  type ContainerPython,
  type PythonPackage,
} from "./api";
import { validateRunTargets, type RunTargetValid } from "@/platform/remoteSettings";
import { AddInterpreterDialog } from "./AddInterpreterDialog";
import { useSetting } from "../components/context";
import { SdkField, tildify } from "./components";
import styles from "./Sdk.module.css";
import { tx } from "@/platform/i18n";

type Op = "install" | "upgrade" | "uninstall";

const DOCSTRING_LABELS: Record<DocstringFormat, string> = {
  plain: "Plain",
  rest: "reStructuredText",
  epytext: "Epytext",
  google: "Google",
  numpy: "NumPy",
};
const DOCSTRING_OPTIONS: readonly SelectOption<DocstringFormat>[] = DOCSTRING_FORMATS.map((value) => ({
  value,
  label: DOCSTRING_LABELS[value],
}));

interface Job {
  op: Op;
  target: string;
  cancel: () => void;
}

export function filterPackages(packages: readonly PythonPackage[], query: string): PythonPackage[] {
  const q = query.trim().toLowerCase();
  return q ? packages.filter((p) => p.name.toLowerCase().includes(q)) : [...packages];
}

function usePackages(python: string | null) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    python: string;
    packages: PythonPackage[] | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!python) return;
    let live = true;
    const key = `${python}#${tick}`;
    listPackages(python)
      .then((packages) => live && setResult({ key, python, packages, error: null }))
      .catch(
        (e: unknown) => live && setResult({ key, python, packages: null, error: String((e as Error)?.message ?? e) }),
      );
    return () => {
      live = false;
    };
  }, [python, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // While reloading the same interpreter, keep showing its previous list.
  const same = !!python && result?.python === python;
  return {
    packages: same ? result.packages : null,
    error: same ? result.error : null,
    loading: !!python && result?.key !== `${python}#${tick}`,
    reload,
  };
}

/** The snapshot of a run target interpreter; polled while one is being taken. */
function useContainerPython(target: string | null) {
  const [state, setState] = useState<{ target: string; info: ContainerPython | null; error: string | null } | null>(
    null,
  );
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!target) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      containerPython()
        .then((info) => {
          if (!live) return;
          setState({ target, info, error: null });
          if (info?.updating) timer = setTimeout(load, 2000);
        })
        .catch((e: unknown) => live && setState({ target, info: null, error: String((e as Error)?.message ?? e) }));
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [target, tick]);
  const refresh = useCallback(() => {
    if (!target) return;
    setRefreshing(true);
    refreshContainerPython()
      .then((info) => setState({ target, info, error: null }))
      .catch((e: unknown) =>
        setState((s) => ({ target, info: s?.info ?? null, error: String((e as Error)?.message ?? e) })),
      )
      .finally(() => {
        setRefreshing(false);
        setTick((t) => t + 1);
      });
  }, [target]);
  const same = !!target && state?.target === target;
  return {
    info: same ? state.info : null,
    error: same ? state.error : null,
    busy: refreshing || (same && !!state.info?.updating),
    loading: !!target && !same,
    refresh,
  };
}

export function PythonInterpreterPage() {
  const [interpreter, setInterpreter] = useSetting<string>("languages.python.interpreter");
  const [activate, setActivate] = useSetting<boolean>("languages.python.activateVirtualenv");
  const root = useProject((s) => s.project?.root ?? null);
  const [auto, setAuto] = useState<string | null>(null);
  const detected = useSdks((s) => s.byKind.python);
  const [rawTargets] = useSetting<RunTargetValid[] | undefined>("runTargets");
  const targets = useMemo(() => targetChoices(validateRunTargets(rawTargets)), [rawTargets]);
  const target = interpreterTarget(interpreter);
  const container = useContainerPython(target);

  useEffect(() => {
    let live = true;
    effectivePython()
      .then((p) => live && setAuto(p))
      .catch(() => live && setAuto(null));
    return () => {
      live = false;
    };
  }, [root]);

  // Without a configured interpreter the project's virtualenv is used (like run configurations).
  const python = target ? null : interpreter || auto;
  const local = usePackages(python);
  const { packages, error, loading, reload } = target
    ? {
        packages: container.info?.version ? container.info.packages : null,
        error: container.error,
        loading: container.loading || container.busy,
        reload: container.refresh,
      }
    : local;
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState(false);
  const [requirement, setRequirement] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const shown = useMemo(() => filterPackages(packages ?? [], query), [packages, query]);

  const run = (op: Op, target: string) => {
    if (!python || job) return;
    setLog([]);
    setJobError(null);
    const s = pip(python, target, op, (line) => setLog((l) => [...l.slice(-400), line]));
    setJob({ op, target, cancel: s.cancel });
    s.promise
      .then(() => {
        if (op === "install") {
          setRequirement("");
          setInstalling(false);
        }
        if (op === "uninstall") setSelected(null);
        reload();
      })
      .catch((e: unknown) => setJobError(isCancelled(e) ? null : String((e as Error)?.message ?? e)))
      .finally(() => setJob(null));
  };

  const menu = (e: MouseEvent, pkg: PythonPackage) => {
    e.preventDefault();
    setSelected(pkg.name);
    showContextMenu(e, [
      { label: "Upgrade", icon: "arrow-up", disabled: !!job, run: () => run("upgrade", pkg.name) },
      { label: "Uninstall", icon: "minus", disabled: !!job, run: () => run("uninstall", pkg.name) },
    ]);
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number) => {
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : -1;
    if (next >= 0 && next < shown.length) {
      e.preventDefault();
      setSelected(shown[next]!.name);
      (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      run("uninstall", selected);
    }
  };

  const autoDetail = auto ? tildify(auto) : "No virtualenv in the project";
  const current = detected?.find((s) => s.path === python);
  const containerDetail = !target
    ? null
    : container.info?.version
      ? `${container.info.name || target} — Python ${container.info.version}${container.info.image ? ` · ${container.info.image.replace(/^sha256:/, "").slice(0, 12)}` : ""}`
      : container.busy
        ? tx("Copying the libraries from the container…")
        : container.info && !container.info.name
          ? tx("No run target has this id: choose another interpreter.")
          : tx("The container's libraries have not been copied yet.");

  return (
    <div className={styles.page}>
      <div className={styles.interpreterRow}>
        <span className={styles.interpreterLabel}>
          <T>Python Interpreter</T>
        </span>
        <SdkField
          kind="python"
          value={interpreter}
          onChange={setInterpreter}
          emptyLabel={auto ? "Project virtualenv (auto-detect)" : "<No interpreter>"}
          emptyDetail={autoDetail}
          browseTitle="Select Python Interpreter"
          aria-label="Python interpreter"
          extra={targets}
        />
        <Button
          size="small"
          onClick={() => setAdding(true)}
          disabled={!root}
          title={root ? undefined : "Open a project first"}
        >
          <T>Add Interpreter…</T>
        </Button>
      </div>
      {containerDetail && (
        <div className={styles.path} title={container.info?.folders.join("\n")}>
          {containerDetail}
        </div>
      )}
      {python && (
        <div className={styles.path} title={python}>
          {current ? `${current.name} — ` : ""}
          {tildify(python)}
        </div>
      )}

      <div className={styles.tablePanel}>
        <div className={styles.tableToolbar} role="toolbar" aria-label={tx("Packages")}>
          <IconButton
            icon="plus"
            size="small"
            title="Install"
            disabled={!python || !!job}
            pressed={installing}
            onClick={() => setInstalling((v) => !v)}
          />
          <IconButton
            icon="minus"
            size="small"
            title="Uninstall"
            disabled={!python || !selected || !!job}
            onClick={() => selected && run("uninstall", selected)}
          />
          <IconButton
            icon="arrow-up"
            size="small"
            title="Upgrade"
            disabled={!python || !selected || !!job}
            onClick={() => selected && run("upgrade", selected)}
          />
          <IconButton
            icon="refresh"
            size="small"
            title={target ? "Copy Libraries from the Container Again" : "Reload List of Packages"}
            disabled={(!python && !target) || loading}
            onClick={reload}
          />
          <span className={styles.spacer} />
          {(loading || job) && <Spinner size={14} label={job ? `${job.op} ${job.target}` : "Loading packages"} />}
          <Input
            className={styles.search}
            value={query}
            placeholder="Search packages"
            aria-label="Search packages"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {installing && (
          <form
            className={styles.installBar}
            onSubmit={(e) => {
              e.preventDefault();
              if (requirement.trim()) run("install", requirement.trim());
            }}
          >
            <Input
              autoFocus
              className={styles.installInput}
              value={requirement}
              placeholder="Package name or requirement, e.g. requests or django==5.1"
              aria-label="Package to install"
              onChange={(e) => setRequirement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setInstalling(false);
                }
              }}
            />
            <Button type="submit" size="small" variant="primary" disabled={!requirement.trim() || !!job}>
              <T>Install Package</T>
            </Button>
          </form>
        )}
        <div className={styles.tableScroll}>
          <table className={styles.table} aria-label={tx("Installed packages")}>
            <thead>
              <tr>
                <th scope="col">
                  <T>Package</T>
                </th>
                <th scope="col">
                  <T>Version</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr
                  key={p.name}
                  tabIndex={selected === p.name || (!selected && i === 0) ? 0 : -1}
                  aria-selected={selected === p.name}
                  className={clsx(selected === p.name && styles.selected)}
                  onMouseDown={() => setSelected(p.name)}
                  onContextMenu={(e) => (target ? undefined : menu(e, p))}
                  onKeyDown={(e) => onRowKey(e, i)}
                >
                  <td>{p.name}</td>
                  <td className={styles.versionCell}>{p.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!python && !target && (
            <div className={styles.empty}>
              <T>No interpreter selected. Choose one above or add a new one.</T>
            </div>
          )}
          {(python || target) && error && (
            <div className={clsx(styles.empty, styles.error)} role="alert">
              {error}
            </div>
          )}
          {(python || target) && !error && packages && shown.length === 0 && (
            <div className={styles.empty}>{query ? tx("No packages match") : tx("No packages installed")}</div>
          )}
          {(python || target) && !error && !packages && loading && (
            <div className={styles.empty}>
              <T>Loading packages…</T>
            </div>
          )}
        </div>
      </div>

      {target && (
        <div className={styles.note}>
          <T>
            Packages come from the container image and are read-only here. To change them, edit the image or its
            requirements and rebuild it, then copy the libraries again.
          </T>
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
        <pre className={styles.log} aria-label={tx("pip output")}>
          {log.join("\n")}
        </pre>
      )}

      <Section title="Terminal">
        <Toggle
          label="Activate virtualenv"
          checked={activate}
          onChange={setActivate}
          hint="New terminal sessions run the interpreter's virtualenv activate script."
        />
      </Section>

      <Section title="Docstrings">
        <SettingSelect
          k="editor.docstringFormat"
          label="Documentation string format"
          hint="Docstring tags and keywords are highlighted according to this markup format (Color Scheme › Python styles their colours)."
          options={DOCSTRING_OPTIONS}
        />
      </Section>

      {adding && root && (
        <AddInterpreterDialog
          root={root}
          onClose={() => setAdding(false)}
          onAdded={(path) => {
            setInterpreter(path);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}
