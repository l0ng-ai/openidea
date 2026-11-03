import { lazy, Suspense, useEffect, useState } from "react";
import type { SyncEntry } from "@/platform/ipc";
import { txTemplate } from "@/platform/i18n";
import { Button, Spinner, T } from "@/ui";
import { diffInput } from "@/features/vcs/diffInput";
import type { DeploymentComparison, DeploymentPreview } from "./comparison";
import styles from "./Deployment.module.css";

const DiffEditor = lazy(() => import("@/features/vcs/DiffEditor").then((m) => ({ default: m.DiffEditor })));

export function SyncPreview({ entry, comparison }: { entry: SyncEntry | null; comparison: DeploymentComparison }) {
  const [loaded, setLoaded] = useState<{
    comparison: DeploymentComparison;
    entry: SyncEntry;
    attempt: number;
    result: DeploymentPreview | null;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current =
    loaded?.comparison === comparison && loaded.entry === entry && loaded.attempt === attempt ? loaded : null;
  const result = current?.result;
  const error = current?.error;
  useEffect(() => {
    const abort = new AbortController();
    if (entry)
      void comparison.preview(entry, abort.signal).then(
        (value) => {
          if (!abort.signal.aborted) setLoaded({ comparison, entry, attempt, result: value, error: null });
        },
        (e: unknown) => {
          if (!abort.signal.aborted)
            setLoaded({
              comparison,
              entry,
              attempt,
              result: null,
              error: txTemplate(e instanceof Error ? e.message : String(e)),
            });
        },
      );
    return () => abort.abort();
  }, [entry, comparison, attempt]);

  return (
    <div className={styles.preview} aria-label="Deployment content comparison">
      {!entry ? (
        <div className={styles.center}>
          <T>Select a file to compare its contents</T>
        </div>
      ) : error ? (
        <div className={styles.previewMessage} role="alert">
          <div className={styles.error}>{error}</div>
          <Button size="small" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : !result ? (
        <div className={styles.center} role="status">
          <Spinner size={14} />
          <T>Loading file contents…</T>
        </div>
      ) : result.kind === "binary" ? (
        <div className={styles.center}>
          <T>Binary files cannot be shown as text</T>
        </div>
      ) : result.kind === "tooLarge" ? (
        <div className={styles.center}>
          <T>This file is too large for the text preview. Use Binary Content to compare it.</T>
        </div>
      ) : (
        <Suspense
          fallback={
            <div className={styles.center}>
              <Spinner size={14} />
            </div>
          }
        >
          <DiffEditor input={diffInput(result.data)} initialMode="split" />
        </Suspense>
      )}
    </div>
  );
}
