import { useState } from "react";
import type { PushTags } from "@/bindings";
import { useProject } from "@/platform/project";
import { remoteLocation, useRemote } from "@/platform/remote";
import { Checkbox, Select } from "@/ui";
import { useVcs } from "./store";
import styles from "./common.module.css";

function storageKey(): string | null {
  const root = useProject.getState().project?.root ?? useVcs.getState().root;
  if (!root) return null;
  const target = useRemote.getState().session?.target;
  return `openidea.vcs.pushTags:${target ? remoteLocation(target, root) : root}`;
}

function readMode(key: string | null): PushTags | null {
  if (!key) return null;
  try {
    const mode = localStorage.getItem(key);
    return mode === "all" || mode === "currentBranch" ? mode : null;
  } catch {
    return null;
  }
}

export function usePushTagOptions() {
  const [{ key, initial }] = useState(() => {
    const key = storageKey();
    return { key, initial: readMode(key) };
  });
  const [enabled, setEnabled] = useState(initial !== null);
  const [mode, setMode] = useState<PushTags>(initial ?? "all");
  const rememberForPush = (): PushTags | null => {
    const selection = enabled ? mode : null;
    if (key) {
      try {
        if (selection) localStorage.setItem(key, selection);
        else localStorage.removeItem(key);
      } catch {
        // A storage failure does not change the submitted options.
      }
    }
    return selection;
  };
  return { enabled, setEnabled, mode, setMode, rememberForPush };
}

export function PushTagOptions({
  enabled,
  setEnabled,
  mode,
  setMode,
}: Pick<ReturnType<typeof usePushTagOptions>, "enabled" | "setEnabled" | "mode" | "setMode">) {
  return (
    <span className={styles.pushTagOptions}>
      <Checkbox checked={enabled} onChange={setEnabled} label="Push tags:" />
      <Select<PushTags>
        value={mode}
        disabled={!enabled}
        aria-label="Tags to push"
        onChange={setMode}
        options={[
          { value: "all", label: "All" },
          { value: "currentBranch", label: "Current Branch" },
        ]}
      />
    </span>
  );
}
