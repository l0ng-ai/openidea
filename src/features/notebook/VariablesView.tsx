/** Jupyter Variables tool window: the variables of the last active notebook's kernel. */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { NotebookVariable } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { EmptyState, T } from "@/ui";
import { maybeEditorService } from "@/workbench/contributions";
import { existingNotebookSession, onNotebookSessionsChange, type NotebookSession } from "./session";
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

function useNotebook(): NotebookSession | null {
  const path = useSyncExternalStore(subscribeActive, notebookPath);
  // A restored notebook tab is active before its session exists.
  return useSyncExternalStore(onNotebookSessionsChange, () => (path && existingNotebookSession(path)) || null);
}

export function VariablesView() {
  const session = useNotebook();
  const source = session ?? noSession;
  const state = useSyncExternalStore(source.subscribe, source.getState);
  const t = useTx();
  // rows null: no kernel running.
  const [loaded, setLoaded] = useState<{ id: string; rows: NotebookVariable[] | null } | null>(null);
  const id = state?.snapshot?.id;
  const settled = !!id && !state.running && !state.frozen && state.kernel === "idle";
  const variables = id && state.kernel !== "dead" && loaded?.id === id ? loaded.rows : null;

  useEffect(() => {
    if (!id || !settled) return;
    let current = true;
    // A busy kernel keeps the last list; the next finished run asks again.
    call(commands.notebookVariables(id)).then(
      (rows) => current && setLoaded({ id, rows }),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [id, settled]);

  if (!session) return <EmptyState title="No notebook open" />;
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
