import { useState, type ReactNode } from "react";
import { tx } from "@/platform/i18n";
import { IconButton, SplitGroup, SplitHandle, SplitPanel, lazyComponent } from "@/ui";
import { diffInput } from "./diffInput";
import type { LogChange } from "./logChanges";
import styles from "./common.module.css";

const DiffEditor = lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor));

const PUSH_DIFF_SPLIT_KEY = "openidea.vcs.push.diffSplit";

export function usePushDiff(shownKey: string) {
  const [state, setState] = useState<{ key: string; change: LogChange } | null>(null);
  return {
    diff: state?.key === shownKey ? state.change : null,
    show: (change: LogChange | null) => setState(change ? { key: shownKey, change } : null),
    close: () => setState(null),
  };
}

interface PushDiffSplitProps {
  diff: LogChange | null;
  onClose: () => void;
  children: ReactNode;
}

export function PushDiffSplit({ diff, onClose, children }: PushDiffSplitProps) {
  return (
    <SplitGroup orientation="vertical" storageKey={diff ? PUSH_DIFF_SPLIT_KEY : undefined} className={styles.pushSplit}>
      <SplitPanel id="sides" minSize="120px" defaultSize="50%" className={styles.pushSplitPanel}>
        {children}
      </SplitPanel>
      {diff && (
        <>
          <SplitHandle />
          <SplitPanel id="diff" minSize="120px" defaultSize="50%" className={styles.pushSplitPanel}>
            <PushDiff change={diff} onClose={onClose} />
          </SplitPanel>
        </>
      )}
    </SplitGroup>
  );
}

function PushDiff({ change, onClose }: { change: LogChange; onClose: () => void }) {
  const input = diffInput(change.diff);
  return (
    <div className={styles.pushDiff}>
      <div className={styles.pushDiffHeader}>
        <span className={styles.pushDiffPath}>{change.path}</span>
        <IconButton icon="close" size="small" title={tx("Close Diff")} onClick={onClose} />
      </div>
      <div className={styles.pushDiffBody}>
        <DiffEditor key={input.key} input={input} />
      </div>
    </div>
  );
}
