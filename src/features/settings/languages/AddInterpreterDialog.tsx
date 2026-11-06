/**
 * PyCharm's "Add Python Interpreter" (local): generate a new environment with a
 * tool (virtualenv / uv / Poetry) or select an existing interpreter.
 */
import { isCancelled } from "@/platform/ipc";
import { useId, useMemo, useState } from "react";
import { Dialog, IconButton, Input, Select, Spinner, type SelectOption, T } from "@/ui";
import { choosePath, createVenv, rememberSdk, type VenvTool } from "./api";
import { tildify, useDetected } from "./components";
import styles from "./Sdk.module.css";
import { tx } from "@/platform/i18n";

type Mode = "new" | "existing";

/** Environment types of the left column, in PyCharm's order. */
const KINDS: { tool: VenvTool; label: string; missing: string }[] = [
  { tool: "venv", label: "Virtualenv Environment", missing: "" },
  { tool: "uv", label: "uv Environment", missing: "uv is not installed" },
  { tool: "poetry", label: "Poetry Environment", missing: "Poetry is not installed" },
];

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
  const bases = useMemo(() => list.filter((s) => s.source !== "venv"), [list]);
  const [base, setBase] = useState<string | null>(null);
  const [location, setLocation] = useState(`${root}/.venv`);
  const [existing, setExisting] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ cancel: () => void } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ids = { base: useId(), location: useId(), existing: useId() };

  const baseValue = base ?? bases[0]?.path ?? null;
  const toOption = (s: { path: string; name: string }): SelectOption => ({
    value: s.path,
    label: s.name,
    detail: tildify(s.path),
  });
  const baseOptions = bases.map(toOption);
  const existingOptions = useMemo(() => {
    const opts = list.map(toOption);
    if (existing && !opts.some((o) => o.value === existing))
      opts.push({ value: existing, label: tildify(existing), detail: "custom" });
    return opts;
  }, [list, existing]);

  const ok = () => {
    setError(null);
    if (mode === "existing") {
      if (existing) onAdded(existing);
      return;
    }
    if (!baseValue || !location.trim()) return;
    setLog([]);
    const job = createVenv(kind, baseValue, location.trim(), (line) => setLog((l) => [...l.slice(-200), line]));
    setBusy({ cancel: job.cancel });
    job.promise
      .then((sdk) => {
        rememberSdk("python", sdk);
        onAdded(sdk.path);
      })
      .catch((e: unknown) => setError(isCancelled(e) ? null : String((e as Error)?.message ?? e)))
      .finally(() => setBusy(null));
  };

  const canOk = mode === "new" ? !!baseValue && !!location.trim() && !busy : !!existing;
  const note = {
    venv: tx("Runs “<base> -m venv <location>”; the new interpreter becomes the project interpreter."),
    uv: tx("Runs “uv venv <location> --python <base>”; the new interpreter becomes the project interpreter."),
    poetry: tx(
      "Runs “poetry env use <base>” in the project; poetry keeps the environment under its own cache directory.",
    ),
  }[kind];

  return (
    <Dialog
      open
      onClose={() => (busy ? busy.cancel() : onClose())}
      title="Add Python Interpreter"
      width={680}
      aria-label="Add Python Interpreter"
      footerStart={busy && <Spinner size={14} label="Creating environment" />}
      buttons={[
        { label: "OK", role: "default", disabled: !canOk, onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>
        <ul className={styles.kinds} aria-label={tx("Interpreter type")}>
          {KINDS.map((k) => (
            <li key={k.tool}>
              <button
                type="button"
                className={`${styles.kind} ${kind === k.tool ? styles.kindOn : ""}`}
                aria-current={kind === k.tool || undefined}
                onClick={() => {
                  setKind(k.tool);
                  setError(null);
                }}
              >
                {k.label}
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.form}>
          <div className={styles.radios} role="radiogroup" aria-label={tx("Environment")}>
            <label className={styles.radio}>
              <input type="radio" name="env" checked={mode === "new"} onChange={() => setMode("new")} />{" "}
              <T>New environment</T>
            </label>
            <label className={styles.radio}>
              <input type="radio" name="env" checked={mode === "existing"} onChange={() => setMode("existing")} />{" "}
              <T>Existing environment</T>
            </label>
          </div>
          {mode === "new" ? (
            <>
              <label htmlFor={ids.location}>
                <T>Location:</T>
              </label>
              <div className={styles.pathRow}>
                <Input
                  id={ids.location}
                  className={styles.pathInput}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  disabled={kind === "poetry"}
                />
                <IconButton
                  icon="folder-open"
                  size="small"
                  title="Browse…"
                  disabled={kind === "poetry"}
                  onClick={async () => {
                    const p = await choosePath({ directory: true, title: "Virtualenv Location", defaultPath: root });
                    if (p) setLocation(p);
                  }}
                />
              </div>
              <label htmlFor={ids.base}>
                <T>Base interpreter:</T>
              </label>
              <div className={styles.pathRow}>
                <Select
                  className={styles.pathInput}
                  value={baseValue}
                  options={baseOptions}
                  onChange={setBase}
                  placeholder={loading ? "Detecting…" : "No Python found"}
                  aria-label="Base interpreter"
                />
                <IconButton
                  icon="folder-open"
                  size="small"
                  title="Browse…"
                  onClick={async () => {
                    const p = await choosePath({ directory: false, title: "Select Base Interpreter" });
                    if (p) setBase(p);
                  }}
                />
              </div>
              <div className={styles.note}>{note}</div>
            </>
          ) : (
            <>
              <label htmlFor={ids.existing}>
                <T>Interpreter:</T>
              </label>
              <div className={styles.pathRow}>
                <Select
                  className={styles.pathInput}
                  value={existing}
                  options={existingOptions}
                  onChange={setExisting}
                  placeholder={loading ? "Detecting…" : "Select an interpreter"}
                  aria-label="Interpreter"
                />
                <IconButton
                  icon="folder-open"
                  size="small"
                  title="Browse…"
                  onClick={async () => {
                    const p = await choosePath({ directory: false, title: "Select Python Interpreter" });
                    if (p) setExisting(p);
                  }}
                />
              </div>
            </>
          )}
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          {log.length > 0 && <pre className={styles.log}>{log.join("\n")}</pre>}
        </div>
      </div>
    </Dialog>
  );
}
