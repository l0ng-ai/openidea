import { useEffect, useState } from "react";
import type { FileStatus } from "@/bindings";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { useVcs } from "./store";

export const TOGGLE_IGNORED_FILES = "vcs.toggleIgnoredFiles";

interface IgnoredFileResult {
  root: string;
  files: FileStatus[];
  failed: boolean;
}

export function useIgnoredFiles(root: string, enabled: boolean) {
  const [result, setResult] = useState<IgnoredFileResult>();
  useEffect(() => {
    if (!enabled || !root) return;
    let live = true;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const files = await call(commands.vcsIgnoredFiles());
        if (live) setResult({ root, files, failed: false });
      } catch {
        if (live) setResult({ root, files: [], failed: true });
      } finally {
        running = false;
        if (live && again) {
          again = false;
          void update();
        }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void update(), 200);
    };
    const offDirectories = onIdeEvent("excludedDirsChanged", schedule);
    const offStatus = useVcs.subscribe((state, prev) => {
      if (state.version !== prev.version) schedule();
    });
    void update();
    return () => {
      live = false;
      clearTimeout(timer);
      offDirectories();
      offStatus();
    };
  }, [enabled, root]);
  return enabled && result?.root === root ? result : undefined;
}
