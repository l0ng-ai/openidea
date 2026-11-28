/**
 * PyCharm's "Add Python Interpreter" (local): generate a new environment with a
 * tool (virtualenv / conda / uv / Poetry / Pipenv / Hatch) or select an existing interpreter.
 */
import { isCancelled } from "@/platform/ipc";
import { useEffect, useId, useMemo, useState } from "react";
import { Checkbox, Dialog, IconButton, Input, Select, Spinner, type SelectOption, T } from "@/ui";
import { Icon, type IconName } from "@/ui/icons";
import { createVenv, hatchEnvs, pythonInterpreter, rememberSdk, type Sdk, type VenvTool } from "./api";
import { choosePath } from "@/platform/choosePath";
import { tildify, useDetected } from "./components";
import styles from "./Sdk.module.css";
import { tx } from "@/platform/i18n";

type Mode = "new" | "existing";

/** Environment types of the left column, in PyCharm's order. */
const KINDS: { tool: VenvTool; label: string; missing: string; icon: IconName }[] = [
  { tool: "venv", label: "Virtualenv Environment", missing: "", icon: "python-venv" },
  { tool: "conda", label: "Conda Environment", missing: "conda is not installed", icon: "python-conda" },
  { tool: "uv", label: "uv Environment", missing: "uv is not installed", icon: "python-uv" },
  { tool: "poetry", label: "Poetry Environment", missing: "Poetry is not installed", icon: "python-poetry" },
  { tool: "pipenv", label: "Pipenv Environment", missing: "Pipenv is not installed", icon: "file-pipenv" },
  { tool: "hatch", label: "Hatch Environment", missing: "Hatch is not installed", icon: "python-hatch" },
];

/** Tools that keep the environment in a directory of their own: the location is not asked for. */
const OWN_LOCATION: ReadonlySet<VenvTool> = new Set(["poetry", "pipenv"]);

export function AddInterpreterDialog({
  root,
  onClose,
  onAdded,
}: {
  root: string;
  onClose: () => void;
  onAdded: (python: string) => void;
}) {
  const { list, loading } = useDetected("python");
  const [kind, setKind] = useState<VenvTool>("venv");
  const [mode, setMode] = useState<Mode>("new");
  const bases = useMemo(() => list.filter((s) => !["venv", "pipenv", "hatch"].includes(s.source)), [list]);
  const [base, setBase] = useState<string | null>(null);
  const [location, setLocation] = useState(`${root}/.venv`);
  // Conda keeps named environments in its own envs directory, so only a name is asked for.
  const [envName, setEnvName] = useState(() => root.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "env");
  const [installPackages, setInstallPackages] = useState(true);
  const [inheritPackages, setInheritPackages] = useState(false);
  const [hatch, setHatch] = useState<{ root: string; names: string[]; error?: string }>();
  const [hatchEnv, setHatchEnv] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [browsed, setBrowsed] = useState<Sdk[]>([]);
  const [busy, setBusy] = useState<{ cancel: () => void } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ids = { base: useId(), location: useId(), existing: useId() };

  const toOption = (s: { path: string; name: string }): SelectOption => ({
    value: s.path,
    label: s.name,
    detail: tildify(s.path),
  });
  // conda installs a fresh Python of the base's version: offer versions, not environments to copy.
  const versionOptions = (() => {
    const seen = new Map<string, SelectOption>();
    for (const s of bases) {
      const short = s.version?.split(".").slice(0, 2).join(".");
      if (short && !seen.has(short)) seen.set(short, { value: s.path, label: tx`Python ${short}` });
    }
    return [...seen.values()].sort((a, b) => b.label.localeCompare(a.label, undefined, { numeric: true }));
  })();
  const baseOptions = kind === "conda" ? versionOptions : bases.map(toOption);
  const baseValue =
    base ?? (kind === "conda" ? (versionOptions[0]?.value as string | undefined) : bases[0]?.path) ?? null;
  const existingOptions = [...browsed, ...list.filter((s) => !browsed.some((b) => b.path === s.path))].map((s) => ({
    value: s.path,
    label: `${s.name} — ${tildify(s.path)}`,
  }));

  const checkExisting = (path: string, onResolved: (sdk: Sdk) => void) => {
    setError(null);
    let cancelled = false;
    setBusy({
      cancel: () => {
        cancelled = true;
        setBusy(null);
      },
    });
    void pythonInterpreter(path)
      .then((sdk) => {
        if (cancelled) return;
        if (!sdk) {
          setError(tx("Cannot run this Python interpreter. Select a working Python executable or virtualenv folder."));
          return;
        }
        onResolved(sdk);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
  };

  useEffect(() => {
    let live = true;
    const job = hatchEnvs();
    void job.promise
      .then((names) => live && setHatch({ root, names }))
      .catch((e: unknown) => {
        if (live && !isCancelled(e)) setHatch({ root, names: [], error: String((e as Error)?.message ?? e) });
      })
      .finally(() => {
        live = false;
      });
    return () => {
      if (live) job.cancel();
      live = false;
    };
  }, [root]);
  const hatchForRoot = hatch?.root === root ? hatch : undefined;
  const hatchNames = hatchForRoot?.names ?? [];
  const hatchEnvValue = hatchEnv && hatchNames.includes(hatchEnv) ? hatchEnv : (hatchNames[0] ?? null);
  const hatchTarget = hatchEnvValue ? `${root}/${hatchEnvValue}` : "";
  const formError = error ?? (kind === "hatch" && mode === "new" ? hatchForRoot?.error : undefined);

  // Poetry and pipenv work on the project itself; the location is only shown, as a hint.
  const shownLocation = OWN_LOCATION.has(kind) ? `${root}/.venv` : location;
  const target = (kind === "conda" ? envName : kind === "hatch" ? hatchTarget : shownLocation).trim();
  const ok = () => {
    if (busy) return;
    setError(null);
    if (mode === "existing") {
      if (existing)
        checkExisting(existing, (sdk) => {
          const detected = list.find((known) => known.source === "hatch" && known.path === sdk.path);
          rememberSdk("python", detected ?? sdk);
          onAdded(sdk.path);
        });
      return;
    }
    if (!baseValue || !target) return;
    setLog([]);
    const inherit = (kind === "venv" || kind === "uv") && inheritPackages;
    const job = createVenv(kind, baseValue, target, kind === "pipenv" && installPackages, inherit, (line) =>
      setLog((l) => [...l.slice(-200), line]),
    );
    setBusy({ cancel: job.cancel });
    job.promise
      .then((sdk) => {
        rememberSdk("python", sdk);
        onAdded(sdk.path);
      })
      .catch((e: unknown) => setError(isCancelled(e) ? null : String((e as Error)?.message ?? e)))
      .finally(() => setBusy(null));
  };

  const canOk = !busy && (mode === "new" ? !!baseValue && !!target : !!existing?.trim());
  const note = {
    venv: inheritPackages
      ? tx(
          "Runs “<base> -m venv --system-site-packages <location>”; the new interpreter becomes the project interpreter.",
        )
      : tx("Runs “<base> -m venv <location>”; the new interpreter becomes the project interpreter."),
    conda: tx(
      "Runs “conda create -n <name> python=<version>”: a new environment with only Python in it, in conda's envs directory; the new interpreter becomes the project interpreter.",
    ),
    uv: inheritPackages
      ? tx(
          "Runs “uv venv <location> --python <base> --system-site-packages”; the new interpreter becomes the project interpreter.",
        )
      : tx("Runs “uv venv <location> --python <base>”; the new interpreter becomes the project interpreter."),
    poetry: tx(
      "Runs “poetry env use <base>” in the project; poetry keeps the environment under its own cache directory.",
    ),
    pipenv: tx(
      "Runs “pipenv --python <base>” in the project, which writes a Pipfile (from requirements.txt if there is one) when the project has none. Pipenv chooses where to store the environment and reuses an existing one.",
    ),
    hatch: tx("Runs “hatch env create <environment>” in the project. Hatch decides where to store the environment."),
  }[kind];

  return (
    <Dialog
      open
      onClose={() => (busy ? busy.cancel() : onClose())}
      title="Add Python Interpreter"
      width={680}
      aria-label="Add Python Interpreter"
      footerStart={
        busy && (
          <Spinner size={14} label={mode === "existing" ? tx("Checking interpreter") : tx("Creating environment")} />
        )
      }
      buttons={[
        { label: "OK", role: "default", disabled: !canOk, onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>
        <ul className={styles.kinds} aria-label={tx("Interpreter type")}>
          {KINDS.filter((k) => k.tool !== "hatch" || hatchNames.length > 0 || hatchForRoot?.error).map((k) => (
            <li key={k.tool}>
              <button
                type="button"
                disabled={!!busy}
                className={`${styles.kind} ${kind === k.tool ? styles.kindOn : ""}`}
                aria-current={kind === k.tool || undefined}
                onClick={() => {
                  setKind(k.tool);
                  setBase(null);
                  setError(null);
                }}
              >
                <Icon name={k.icon} size={16} />
                <T>{k.label}</T>
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.form}>
          <div className={styles.radios} role="radiogroup" aria-label={tx("Environment")}>
            <label className={styles.radio}>
              <input
                type="radio"
                name="env"
                disabled={!!busy}
                checked={mode === "new"}
                onChange={() => setMode("new")}
              />{" "}
              <T>New environment</T>
            </label>
            <label className={styles.radio}>
              <input
                type="radio"
                name="env"
                disabled={!!busy}
                checked={mode === "existing"}
                onChange={() => setMode("existing")}
              />{" "}
              <T>Existing environment</T>
            </label>
          </div>
          {mode === "new" ? (
            <>
              {kind === "conda" ? (
                <>
                  <label htmlFor={ids.location}>
                    <T>Name:</T>
                  </label>
                  <Input id={ids.location} value={envName} onChange={(e) => setEnvName(e.target.value)} />
                </>
              ) : kind === "hatch" ? (
                <>
                  <label htmlFor={ids.location}>
                    <T>Environment:</T>
                  </label>
                  <Select
                    id={ids.location}
                    value={hatchEnvValue}
                    options={hatchNames.map((name) => ({ value: name, label: name, verbatim: true }))}
                    onChange={setHatchEnv}
                    placeholder="No environments"
                    aria-label={tx("Hatch environment")}
                  />
                </>
              ) : (
                <>
                  <label htmlFor={ids.location}>
                    <T>Location:</T>
                  </label>
                  <div className={styles.pathRow}>
                    <Input
                      id={ids.location}
                      className={styles.pathInput}
                      value={shownLocation}
                      onChange={(e) => setLocation(e.target.value)}
                      disabled={OWN_LOCATION.has(kind)}
                    />
                    <IconButton
                      icon="folder-open"
                      size="small"
                      title="Browse…"
                      disabled={OWN_LOCATION.has(kind)}
                      onClick={async () => {
                        const p = await choosePath({
                          directory: true,
                          title: "Virtualenv Location",
                          defaultPath: root,
                        });
                        if (p) setLocation(p);
                      }}
                    />
                  </div>
                </>
              )}
              <label htmlFor={ids.base}>{kind === "conda" ? <T>Python version:</T> : <T>Base interpreter:</T>}</label>
              <div className={styles.pathRow}>
                <Select
                  className={styles.pathInput}
                  value={baseValue}
                  options={baseOptions}
                  onChange={setBase}
                  placeholder={loading ? "Detecting…" : "No Python found"}
                  aria-label={kind === "conda" ? "Python version" : "Base interpreter"}
                />
                {kind !== "conda" && (
                  <IconButton
                    icon="folder-open"
                    size="small"
                    title="Browse…"
                    onClick={async () => {
                      const p = await choosePath({ directory: false, title: "Select Base Interpreter" });
                      if (p) setBase(p);
                    }}
                  />
                )}
              </div>
              {(kind === "venv" || kind === "uv") && (
                <Checkbox
                  checked={inheritPackages}
                  onChange={setInheritPackages}
                  disabled={!!busy}
                  label={tx("Inherit packages from base interpreter")}
                />
              )}
              {kind === "pipenv" && (
                <Checkbox
                  checked={installPackages}
                  onChange={setInstallPackages}
                  disabled={!!busy}
                  label={tx("Install packages from Pipfile")}
                />
              )}
              <div className={styles.note}>{note}</div>
            </>
          ) : (
            <>
              <label htmlFor={ids.existing}>
                <T>Interpreter:</T>
              </label>
              <div className={styles.pathRow}>
                <Select
                  id={ids.existing}
                  className={styles.pathInput}
                  value={existing}
                  disabled={!!busy}
                  options={existingOptions}
                  onChange={setExisting}
                  placeholder={loading ? "Detecting…" : "Select an interpreter"}
                  aria-label="Interpreter"
                />
                <IconButton
                  icon="folder-open"
                  size="small"
                  title="Browse…"
                  disabled={!!busy}
                  onClick={async () => {
                    const p = await choosePath({
                      directory: true,
                      title: "Select Python Environment Folder",
                      defaultPath: root,
                    });
                    if (p)
                      checkExisting(p, (sdk) => {
                        setBrowsed((current) => [sdk, ...current.filter((s) => s.path !== sdk.path)]);
                        setExisting(sdk.path);
                      });
                  }}
                />
              </div>
            </>
          )}
          {formError && (
            <div className={styles.error} role="alert">
              <T>{formError}</T>
            </div>
          )}
          {log.length > 0 && <pre className={styles.log}>{log.join("\n")}</pre>}
        </div>
      </div>
    </Dialog>
  );
}
