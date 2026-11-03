/**
 * Settings › Python › Interpreter (PyCharm's "Python Interpreter" page): the
 * project interpreter and its packages (pip / uv pip). The interpreter feeds
 * run configurations, basedpyright / pyright (`python.pythonPath`) and the
 * terminal's virtualenv activation.
 */
import { isCancelled } from "@/platform/ipc";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { Button, IconButton, Input, Spinner, showContextMenu, T } from "@/ui";
import { useProject } from "@/platform/project";
import { Section, Toggle } from "../components/Form";
import { effectivePython, listPackages, pip, useSdks, type PythonPackage } from "./api";
import { AddInterpreterDialog } from "./AddInterpreterDialog";
import { useSetting } from "../components/context";
import { SdkField, tildify } from "./components";
import styles from "./Sdk.module.css";
import { tx } from "@/platform/i18n";

type Op = "install" | "upgrade" | "uninstall";

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

export function PythonInterpreterPage() {
  const [interpreter, setInterpreter] = useSetting<string>("languages.python.interpreter");
  const [activate, setActivate] = useSetting<boolean>("languages.python.activateVirtualenv");
  const root = useProject((s) => s.project?.root ?? null);
  const [auto, setAuto] = useState<string | null>(null);
  const detected = useSdks((s) => s.byKind.python);

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
  const python = interpreter || auto;
  const { packages, error, loading, reload } = usePackages(python);
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
            disabled={!selected || !!job}
            onClick={() => selected && run("uninstall", selected)}
          />
          <IconButton
            icon="arrow-up"
            size="small"
            title="Upgrade"
            disabled={!selected || !!job}
            onClick={() => selected && run("upgrade", selected)}
          />
          <IconButton
            icon="refresh"
            size="small"
            title="Reload List of Packages"
            disabled={!python || loading}
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
                  onContextMenu={(e) => menu(e, p)}
                  onKeyDown={(e) => onRowKey(e, i)}
                >
                  <td>{p.name}</td>
                  <td className={styles.versionCell}>{p.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!python && (
            <div className={styles.empty}>
              <T>No interpreter selected. Choose one above or add a new one.</T>
            </div>
          )}
          {python && error && (
            <div className={clsx(styles.empty, styles.error)} role="alert">
              {error}
            </div>
          )}
          {python && !error && packages && shown.length === 0 && (
            <div className={styles.empty}>{query ? tx("No packages match") : tx("No packages installed")}</div>
          )}
          {python && !error && !packages && loading && (
            <div className={styles.empty}>
              <T>Loading packages…</T>
            </div>
          )}
        </div>
      </div>

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
