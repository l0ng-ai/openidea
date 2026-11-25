import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { tx } from "@/platform/i18n";
import { IconButton, SplitGroup, SplitHandle, SplitPanel, lazyComponent } from "@/ui";
import { diffInput } from "./diffInput";
import type { LogChange } from "./logChanges";
import styles from "./common.module.css";

const DiffEditor = lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor));

const PUSH_DIFF_SPLIT_KEY = "openidea.vcs.push.diffSplit";
const PUSH_SIDES_SPLIT_KEY = "openidea.vcs.pushSides";
const PUSH_STACKED_SPLIT_KEY = "openidea.vcs.push.stackedSplit";
const SIDE_LAYOUT = { commits: 50, changes: 50 };
const STACKED_LAYOUT = { commits: 34, changes: 66 };

export function usePushDiff(shownKey: string) {
  const [state, setState] = useState<{ key: string; change: LogChange } | null>(null);
  return {
    diff: state?.key === shownKey ? state.change : null,
    show: (change: LogChange | null) => setState(change ? { key: shownKey, change } : null),
    close: () => setState(null),
  };
}

interface PushReviewProps {
  diff: LogChange | null;
  onClose: () => void;
  commits: ReactNode;
  changes: ReactNode;
}

export function PushReview({ diff, onClose, commits, changes }: PushReviewProps) {
  const summary = useRef<HTMLDivElement>(null);
  const group = useRef<GroupImperativeHandle>(null);
  const [stacked, setStacked] = useState(false);
  const previous = useRef(stacked);
  const layout = stacked ? STACKED_LAYOUT : SIDE_LAYOUT;
  useLayoutEffect(() => {
    const el = summary.current;
    if (!el) return;
    const measure = () => setStacked(el.clientWidth < 640);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (previous.current === stacked) return;
    previous.current = stacked;
    group.current?.setLayout(layout);
  }, [stacked, layout]);

  return (
    <SplitGroup orientation="vertical" storageKey={diff ? PUSH_DIFF_SPLIT_KEY : undefined} className={styles.pushSplit}>
      <SplitPanel id="sides" minSize="32%" defaultSize="58%" className={styles.pushSplitPanel}>
        <SplitGroup
          elementRef={summary}
          groupRef={group}
          orientation={stacked ? "vertical" : "horizontal"}
          storageKey={stacked ? PUSH_STACKED_SPLIT_KEY : PUSH_SIDES_SPLIT_KEY}
          defaultLayout={layout}
          className={styles.pushSides}
        >
          <SplitPanel id="commits" minSize={stacked ? "24%" : "240px"} className={styles.pushSplitPanel}>
            {commits}
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="changes" minSize={stacked ? "32%" : "240px"} className={styles.pushSplitPanel}>
            {changes}
          </SplitPanel>
        </SplitGroup>
      </SplitPanel>
      {diff && (
        <>
          <SplitHandle />
          <SplitPanel id="diff" minSize="25%" className={styles.pushSplitPanel}>
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
