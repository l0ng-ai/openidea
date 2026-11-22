import { useEffect, useMemo, useState } from "react";
import type { RevisionChange } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { Dialog, IconButton, Spinner, T, lazyComponent } from "@/ui";
import { ComparisonTree } from "./ComparisonTree";
import { diffInput, diffTitle, type DiffData } from "./diffInput";
import { showDiffWindow } from "./DiffWindow";
import { openDialog } from "./dialogs";
import { buildFileTree } from "./fileTree";
import { toLogChanges, type LogChange } from "./logChanges";
import { KIND_COLOR, fileCount } from "./model";
import { errorMessage } from "./ops";
import styles from "./common.module.css";

const DiffEditor = lazyComponent(() => import("./DiffEditor").then((module) => module.DiffEditor));

function showChangeDiff(diff: DiffData) {
  showDiffWindow(diff, () =>
    openDialog((close) => (
      <Dialog open title={diffTitle(diff)} width={960} onClose={close} className={styles.rebaseDialog} resizable="both">
        <DiffEditor input={diffInput(diff)} />
      </Dialog>
    )),
  );
}

export function RebasePlanChanges({ repo, selection }: { repo: string | null; selection: string }) {
  const [result, setResult] = useState<RevisionChange[] | string | null>(null);
  const [current, setCurrent] = useState<LogChange | null>(null);
  useEffect(() => {
    const request = nextRequestId();
    let active = true;
    let pending = true;
    void call(commands.vcsCommitSelectionChanges(repo, selection.split(" "), request))
      .then((changes) => active && setResult(changes))
      .catch((error) => active && setResult(errorMessage(error)))
      .finally(() => {
        pending = false;
      });
    return () => {
      active = false;
      if (pending) void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [repo, selection]);

  const tree = useMemo(
    () => (Array.isArray(result) ? buildFileTree(toLogChanges(result, null, repo, true), (change) => change.path) : []),
    [repo, result],
  );
  return (
    <section className={styles.rebaseChanges} aria-label={tx("Changed files")}>
      <div className={styles.rebaseChangesToolbar}>
        <IconButton
          icon="diff"
          title="Show Diff"
          size="small"
          disabled={!current}
          onClick={() => current && showChangeDiff(current.diff)}
        />
        {Array.isArray(result) && <span>{fileCount(result.length)}</span>}
      </div>
      {result === null ? (
        <div className={styles.empty} role="status" aria-label={tx("Loading…")}>
          <Spinner size={14} />
        </div>
      ) : typeof result === "string" ? (
        <div className={styles.error} role="alert">
          {result}
        </div>
      ) : result.length ? (
        <ComparisonTree
          tree={tree}
          current={current}
          onSelect={setCurrent}
          diffFor={(change) => change.diff}
          getColor={(change) => KIND_COLOR[change.kind === "untracked" ? "added" : change.kind]}
          renderDetails={() => null}
          ariaLabel="Changed files"
          inlineDiff={false}
          openOnActivate
          openDiff={showChangeDiff}
        />
      ) : (
        <div className={styles.empty}>
          <T>No changes</T>
        </div>
      )}
    </section>
  );
}
