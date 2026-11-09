import { useEffect, type ReactNode } from "react";
import type { EditorInput } from "@/workbench/contributions";
import { LogIdContext, LogOptionsContext } from "./logContext";
import { rootLogOptions } from "./logOptions";
import { ensureEditorLog, focusLogView, parkedLogOptions, useRootGitLog } from "./logStore";
import { LogView } from "./GitLog";
import styles from "./GitLog.module.css";

export function LogScope({ id, children }: { id: string; children: ReactNode }) {
  const active = useRootGitLog((s) => s.shownLog);
  const options = rootLogOptions();
  const focus = () => {
    if (useRootGitLog.getState().shownLog !== id) focusLogView(id);
  };
  return (
    <LogIdContext.Provider value={id}>
      <LogOptionsContext.Provider value={active === id ? options : (parkedLogOptions(id) ?? options)}>
        <div className={styles.root} data-git-log onPointerDownCapture={focus} onFocusCapture={focus}>
          {children}
        </div>
      </LogOptionsContext.Provider>
    </LogIdContext.Provider>
  );
}

export function GitLogEditor({ input }: { input: EditorInput }) {
  const data = input.data as { id: string; label: string };
  useEffect(() => {
    ensureEditorLog(data.id, data.label);
    focusLogView(data.id);
  }, [data.id, data.label]);
  return (
    <LogScope id={data.id}>
      <LogView />
    </LogScope>
  );
}
