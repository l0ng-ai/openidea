import { useEffect, useState, useSyncExternalStore } from "react";
import type { BranchInfo } from "@/bindings";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { currentRepoFor } from "./repoBranches";
import { useVcs } from "./store";

const activePath = () => maybeEditorService()?.activeInput?.()?.path ?? null;
const subscribeActiveInput = (fn: () => void) => maybeEditorService()?.onActiveInputChange?.(fn) ?? (() => {});

export function activeRepository(): string | null {
  const { roots, repo } = useVcs.getState();
  return currentRepoFor(activePath(), roots, repo);
}

export function useActiveRepository(): string | null {
  const path = useSyncExternalStore(subscribeActiveInput, activePath);
  return useVcs((s) => currentRepoFor(path, s.roots, s.repo));
}

/** Read one repository's full branch state without selecting it for other Git tools. */
export function useWidgetBranch(repo: string | null): BranchInfo | null {
  const project = useVcs((s) => s.root);
  const scoped = useVcs((s) => (s.roots.length > 1 && repo !== s.branchRoot ? repo : null));
  const selected = useVcs((s) => (scoped ? null : s.branch));
  const head = useVcs((s) => (scoped ? s.heads[scoped] : undefined));
  const operation = useVcs((s) => (scoped ? (s.operations[scoped] ?? null) : null));
  const [loaded, setLoaded] = useState<{ project: string | null; repo: string; info: BranchInfo | null } | null>(null);

  useEffect(() => {
    if (!scoped) return;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++generation;
      const info = await call(commands.vcsBranchInfo(scoped)).catch(() => null);
      if (generation === request) setLoaded({ project, repo: scoped, info });
    };
    const schedule = () => {
      generation++;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 200);
    };
    const offVcs = useVcs.subscribe((s, prev) => {
      const now = s.heads[scoped];
      const before = prev.heads[scoped];
      if (
        now?.head !== before?.head ||
        now?.headCommit !== before?.headCommit ||
        s.operations[scoped] !== prev.operations[scoped] ||
        (prev.remoteBusy && !s.remoteBusy)
      )
        schedule();
    });
    const offRefs = onIdeEvent("vcsChanged", schedule);
    void refresh();
    return () => {
      generation++;
      clearTimeout(timer);
      offVcs();
      offRefs();
    };
  }, [project, scoped]);

  if (!scoped) return selected;
  const info = loaded?.project === project && loaded.repo === scoped ? loaded.info : null;
  if (
    info &&
    (!head || (info.head === head.head && info.headCommit === head.headCommit && info.operation === operation))
  )
    return info;
  return head ? { head: head.head, headCommit: head.headCommit, operation, upstream: null, ahead: 0, behind: 0 } : null;
}
