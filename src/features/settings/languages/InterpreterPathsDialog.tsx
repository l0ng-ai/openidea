/**
 * PyCharm's "Show Paths for Selected Interpreter": the interpreter's `sys.path` and the
 * folders the user adds to it. The added folders are saved per interpreter in the global
 * settings and reach the language server, runs, debug sessions, tests and the console.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { choosePath } from "@/platform/choosePath";
import { tx } from "@/platform/i18n";
import { Dialog, IconButton, Spinner, T } from "@/ui";
import { useSetting } from "../components/context";
import { pythonSysPath, pythonUserPathProblems, type UserPathProblem } from "./api";
import { tildify } from "./components";
import { addUserPath, interpreterPathKey, sameInterpreterPath } from "./interpreters";
import styles from "./Sdk.module.css";

interface PathRow {
  id: string;
  path: string;
  /** Added by the user: the only rows that can be removed. */
  added: boolean;
}

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
  const [own, setOwn] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<{ reloads: number; error: string | null } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [problems, setProblems] = useState<Record<string, UserPathProblem>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // Keyboard moves take the focus along with the selection; mouse and toolbar ones don't.
  const focusSelected = useRef(false);

  // The interpreter runs once per (re)load; closing the dialog stops a query still running.
  useEffect(() => {
    let settled = false;
    let stale = false;
    const query = pythonSysPath(interpreter);
    query.promise
      .then((paths) => {
        settled = true;
        if (stale) return;
        setOwn(paths);
        setLoaded({ reloads, error: null });
      })
      .catch((e: unknown) => {
        settled = true;
        if (!stale) setLoaded({ reloads, error: String((e as Error)?.message ?? e) });
      });
    return () => {
      stale = true;
      if (!settled) query.cancel();
    };
  }, [interpreter, reloads]);
  const loading = loaded?.reloads !== reloads;
  const error = loading ? null : loaded.error;

  const userKey = user.join("\n");
  useEffect(() => {
    let stale = false;
    const paths = userKey ? userKey.split("\n") : [];
    pythonUserPathProblems(paths)
      .then((found) => {
        if (stale) return;
        setProblems(Object.fromEntries(paths.flatMap((path, i) => (found[i] ? [[path, found[i]]] : []))));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [userKey, reloads]);

  const rows: PathRow[] = [
    ...own.map((path) => ({ id: `own:${path}`, path, added: false })),
    ...user.map((path) => ({ id: `user:${path}`, path, added: true })),
  ];
  const selectedRow = rows.find((row) => row.id === selected) ?? null;

  useEffect(() => {
    if (!focusSelected.current) return;
    focusSelected.current = false;
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  });

  const add = async () => {
    const picked = await choosePath({ directory: true, title: tx("Add Interpreter Path") });
    if (!picked) return;
    setUser(addUserPath(user, own, picked));
    // A folder that is already listed is shown instead of added twice.
    const same = rows.find((row) => interpreterPathKey(row.path) === interpreterPathKey(picked));
    setSelected(same?.id ?? `user:${picked}`);
  };
  const remove = (row: PathRow, keepFocus: boolean) => {
    if (!row.added) return;
    const i = rows.indexOf(row);
    setUser(user.filter((path) => path !== row.path));
    setSelected((rows[i + 1] ?? rows[i - 1])?.id ?? null);
    focusSelected.current = keepFocus;
  };
  const ok = () => {
    const next = { ...all };
    if (user.length) next[key] = user;
    else delete next[key];
    setAll(next);
    onClose();
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const next =
      e.key === "ArrowDown"
        ? i + 1
        : e.key === "ArrowUp"
          ? i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? rows.length - 1
              : -1;
    if (next >= 0 && next < rows.length) {
      e.preventDefault();
      setSelected(rows[next]!.id);
      focusSelected.current = true;
    } else if ((e.key === "Delete" || e.key === "Backspace") && rows[i]?.added) {
      e.preventDefault();
      remove(rows[i], true);
    }
  };

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
              disabled={!selectedRow?.added}
              onClick={() => selectedRow && remove(selectedRow, false)}
            />
            <IconButton icon="refresh" size="small" title="Reload Paths" onClick={() => setReloads(reloads + 1)} />
          </div>
          <div ref={list} className={styles.tableScroll} role="listbox" aria-label={tx("Interpreter Paths")}>
            {rows.map((row, i) => (
              <div
                key={row.id}
                role="option"
                aria-selected={selected === row.id}
                tabIndex={selected === row.id || (!selectedRow && i === 0) ? 0 : -1}
                className={clsx(styles.interpretersRow, selected === row.id && styles.selected)}
                onMouseDown={() => setSelected(row.id)}
                onFocus={() => setSelected(row.id)}
                onKeyDown={(e) => onRowKey(e, i)}
              >
                <span className={styles.interpretersText}>
                  <span className={styles.interpretersName} title={row.path}>
                    {tildify(row.path)}
                  </span>
                </span>
                {row.added && (
                  <span className={styles.badge}>
                    <T>added by user</T>
                  </span>
                )}
                {row.added && problems[row.path] === "missing" && (
                  <span className={styles.interpretersInvalid}>
                    <T>Missing</T>
                  </span>
                )}
                {row.added && problems[row.path] === "invalid" && (
                  <span
                    className={styles.interpretersInvalid}
                    title={tx("Not an absolute path, or it contains the separator of PYTHONPATH")}
                  >
                    <T>Invalid</T>
                  </span>
                )}
              </div>
            ))}
            {error && <div className={clsx(styles.empty, styles.error)}>{error}</div>}
          </div>
        </div>
        <div className={styles.note}>
          <T>Added folders are on the import path of every project that uses this interpreter.</T>{" "}
          <T>Runs search them before the interpreter's own paths.</T>
        </div>
      </div>
    </Dialog>
  );
}
