/**
 * PyCharm's "Show Paths for Selected Interpreter": the interpreter's `sys.path` and the
 * folders the user adds to it. The added folders are saved per interpreter in the global
 * settings and reach the language server, runs, debug sessions, tests and the console.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { choosePath } from "@/platform/choosePath";
import { tx } from "@/platform/i18n";
import { Dialog, IconButton, Spinner, T } from "@/ui";
import { useSetting } from "../components/context";
import { pythonSysPath, type PythonSysPath } from "./api";
import { tildify } from "./components";
import { addUserPath, sameInterpreterPath } from "./interpreters";
import styles from "./Sdk.module.css";

export function InterpreterPathsDialog({
  interpreter,
  name,
  onClose,
}: {
  interpreter: string;
  name: string;
  onClose: () => void;
}) {
  const [all, setAll] = useSetting<Record<string, string[]>>("languages.python.interpreterPaths");
  const key = Object.keys(all ?? {}).find((k) => sameInterpreterPath(k, interpreter, null)) ?? interpreter;
  const [user, setUser] = useState<string[]>(() => all?.[key] ?? []);
  const [result, setResult] = useState<PythonSysPath | null>(null);
  const [loaded, setLoaded] = useState<{ request: string; error: string | null } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const userKey = user.join("\n");
  const request = `${reloads}\n${userKey}`;
  useEffect(() => {
    let stale = false;
    pythonSysPath(interpreter, userKey ? userKey.split("\n") : [])
      .then((r) => {
        if (stale) return;
        setResult(r);
        setLoaded({ request, error: null });
      })
      .catch((e: unknown) => !stale && setLoaded({ request, error: String((e as Error)?.message ?? e) }));
    return () => {
      stale = true;
    };
  }, [interpreter, userKey, request]);
  const loading = loaded?.request !== request;
  const error = loading ? null : loaded.error;

  const add = async () => {
    const picked = await choosePath({ directory: true, title: tx("Add Interpreter Path") });
    if (!picked) return;
    setUser(addUserPath(user, result?.paths ?? [], picked));
    setSelected(picked);
  };
  const remove = () => {
    setUser(user.filter((path) => path !== selected));
    setSelected(null);
  };
  const ok = () => {
    const next = { ...all };
    if (user.length) next[key] = user;
    else delete next[key];
    setAll(next);
    onClose();
  };

  const row = (path: string, added: boolean) => (
    <div
      key={`${added}:${path}`}
      role="option"
      aria-selected={selected === path}
      tabIndex={0}
      className={clsx(styles.interpretersRow, selected === path && styles.selected)}
      onMouseDown={() => setSelected(path)}
      onFocus={() => setSelected(path)}
      onKeyDown={(e) => {
        if (added && (e.key === "Delete" || e.key === "Backspace")) remove();
      }}
    >
      <span className={styles.interpretersText}>
        <span className={styles.interpretersName} title={path}>
          {tildify(path)}
        </span>
      </span>
      {added && (
        <span className={styles.badge}>
          <T>added by user</T>
        </span>
      )}
      {added && result?.missing.includes(path) && (
        <span className={styles.interpretersInvalid}>
          <T>Missing</T>
        </span>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={tx`Interpreter Paths: ${name}`}
      width={620}
      aria-label={tx("Interpreter Paths")}
      footerStart={loading && <Spinner size={14} label={tx("Reading sys.path")} />}
      buttons={[
        { label: "OK", role: "default", onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.pathsDialog}>
        <div className={styles.tablePanel}>
          <div className={styles.tableToolbar} role="toolbar" aria-label={tx("Interpreter Paths")}>
            <IconButton icon="plus" size="small" title="Add Path…" onClick={() => void add()} />
            <IconButton
              icon="minus"
              size="small"
              title="Remove Path"
              disabled={!selected || !user.includes(selected)}
              onClick={remove}
            />
            <IconButton icon="refresh" size="small" title="Reload Paths" onClick={() => setReloads(reloads + 1)} />
          </div>
          <div className={styles.tableScroll} role="listbox" aria-label={tx("Interpreter Paths")}>
            {result?.paths.map((path) => row(path, false))}
            {user.map((path) => row(path, true))}
            {error && <div className={clsx(styles.empty, styles.error)}>{error}</div>}
          </div>
        </div>
        <div className={styles.note}>
          <T>Added folders are on the import path of every project that uses this interpreter.</T>
        </div>
      </div>
    </Dialog>
  );
}
