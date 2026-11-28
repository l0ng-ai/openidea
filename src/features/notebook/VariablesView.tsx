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

/** The active notebook tab's session, else the session of the notebook active last. */
function notebookSession(): NotebookSession | null {
  const path = activePath();
  // A restored notebook tab is active before its session exists: wait for it.
  if (path && /\.ipynb$/i.test(path)) return existingNotebookSession(path) ?? null;
  return [...notebookSessions()].at(-1) ?? null;
}

function useNotebook(): NotebookSession | null {
  useSyncExternalStore(subscribeActive, activePath);
  return useSyncExternalStore(onNotebookSessionsChange, notebookSession);
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
