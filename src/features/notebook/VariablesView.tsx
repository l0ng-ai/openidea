/** Jupyter Variables tool window: the variables of the last active notebook's kernel. */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { NotebookVariable } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { call, commands, IpcError } from "@/platform/ipc";
import { EmptyState, T } from "@/ui";
import { maybeEditorService } from "@/workbench/contributions";
import { existingNotebookSession, notebookSessions, onNotebookSessionsChange, type NotebookSession } from "./session";
import styles from "./VariablesView.module.css";

const activePath = () => maybeEditorService()?.activeInput?.()?.path ?? null;
const subscribeActive = (fn: () => void) => maybeEditorService()?.onActiveInputChange?.(fn) ?? (() => {});
const noSession = { subscribe: () => () => {}, getState: () => null };

let lastNotebook: string | null = null;
/** The notebook tab last made active; other tabs keep it. */
function notebookPath(): string | null {
  const path = activePath();
  if (path && /\.ipynb$/i.test(path)) lastNotebook = path;
  return lastNotebook;
}

function notebookSession(path: string | null): NotebookSession | null {
  const session = path && existingNotebookSession(path);
  if (session) return session;
  // A restored notebook tab is active before its session exists: wait for it.
  if (path && path === activePath()) return null;
  // Tab changes are seen only while this window is shown; before that, or once that
  // notebook is closed, the notebook opened last stands in for the one active last.
  return [...notebookSessions()].at(-1) ?? null;
}

function useNotebook(): NotebookSession | null {
  const path = useSyncExternalStore(subscribeActive, notebookPath);
  return useSyncExternalStore(onNotebookSessionsChange, () => notebookSession(path));
}

export function VariablesView() {
  const session = useNotebook();
  const source = session ?? noSession;
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const t = useTx();
  // rows null: no kernel running.
  const [loaded, setLoaded] = useState<{ id: string; rows: NotebookVariable[] | null; error?: string } | null>(null);
  const id = state?.snapshot?.id;
  const settled = !!id && !state.running && !state.frozen && state.kernel === "idle";
  const current = id && state.kernel !== "dead" && loaded?.id === id ? loaded : null;
  const variables = current?.rows ?? null;

  useEffect(() => {
    if (!id || !settled) return;
    let live = true;
    call(commands.notebookVariables(id)).then(
      (rows) => live && setLoaded({ id, rows }),
      (error: unknown) => {
        // A busy kernel keeps the last list; the next finished run asks again.
        if (!live || (error instanceof IpcError && (error.kind === "unavailable" || error.kind === "cancelled")))
          return;
        setLoaded((last) => ({
          id,
          rows: last?.id === id ? last.rows : null,
          error: String((error as Error).message ?? error),
        }));
      },
    );
    return () => {
      live = false;
    };
  }, [id, settled]);

  if (!session) return <EmptyState title="No notebook open" />;
  if (current?.error)
    return (
      <EmptyState title="Could not read the variables">
        <span className={styles.error}>{current.error}</span>
      </EmptyState>
    );
  if (!variables)
    return (
      <EmptyState title="No kernel running">
        <T>Run a cell to start the kernel.</T>
      </EmptyState>
    );
  if (!variables.length) return <EmptyState title="No variables" />;
  return (
    <div role="list" aria-label={t("Jupyter variables")} className={styles.list}>
      {variables.map((v) => (
        <div role="listitem" key={v.name} className={styles.row} title={v.value}>
          <span className={styles.name}>{v.name}</span>
          <span className={styles.type}>{v.type}</span>
          <span className={styles.value}>{v.value}</span>
        </div>
      ))}
    </div>
  );
}
