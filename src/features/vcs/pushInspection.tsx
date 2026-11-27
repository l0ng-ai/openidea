import { useEffect, useState } from "react";
import type { BranchInfo, PushInspection, PushSelection, PushTags } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { toolWindowService } from "@/workbench/contributions";
import { upsertTaskSoon } from "@/workbench/tasks";
import { runRemoteRound } from "./ops";
import type { PushOp } from "./pushTarget";
import { useVcs } from "./store";
import styles from "./common.module.css";

export interface InspectionTarget {
  repo: string | null;
  selection: PushSelection;
}

/** A cancellable check for Commit and Push, with no dialog to own the request. */
export async function inspectPushTargets(targets: readonly InspectionTarget[]): Promise<PushInspection[] | null> {
  const requests = targets.map(() => nextRequestId());
  const id = `vcs:push-check:${requests[0]}`;
  const title = tx("Checking remote before pushing");
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    for (const request of requests) void commands.cancelRequest(request).catch(() => undefined);
  };
  upsertTaskSoon({ id, title, message: null, fraction: null, done: false, cancel });
  try {
    const results = await Promise.allSettled(
      targets.map(({ repo, selection }, i) => call(commands.vcsInspectPush(repo, requests[i]!, selection, true))),
    );
    if (cancelled || results.some((result) => result.status === "rejected")) return null;
    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  } finally {
    upsertTaskSoon({ id, title, message: null, fraction: 1, done: true });
  }
}

function identity({ repo, selection }: InspectionTarget): string {
  return JSON.stringify([
    repo,
    selection.branch,
    selection.revision,
    selection.remote,
    selection.target,
    selection.specialRef,
  ]);
}

/** Keep results scoped to the exact source and target the user is looking at. */
export function usePushInspection(targets: readonly InspectionTarget[]) {
  const key = JSON.stringify(targets);
  const [generation, recheck] = useState(0);
  const [results, setResults] = useState<Record<string, PushInspection>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [fetching, setFetching] = useState(false);
  useEffect(() => {
    const candidates = JSON.parse(key) as InspectionTarget[];
    const requests = new Set<number>();
    let active = true;
    const inspect = async (target: InspectionTarget, live: boolean) => {
      const request = nextRequestId();
      requests.add(request);
      try {
        const value = await call(commands.vcsInspectPush(target.repo, request, target.selection, live));
        if (active && value) {
          const id = identity(target);
          setResults((old) => (!live && old[id] ? old : { ...old, [id]: value }));
        }
      } catch {
        // The local result is still useful when the remote cannot be reached.
      } finally {
        requests.delete(request);
      }
    };
    for (const target of candidates) void inspect(target, false);
    const timer = window.setTimeout(() => {
      for (const target of candidates) void inspect(target, true);
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
      for (const request of requests) void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [key, generation]);

  const resultOf = (target: InspectionTarget | null) => (target ? results[identity(target)] : undefined);
  const incoming = targets.flatMap((target) => {
    const preview = resultOf(target);
    return preview && preview.state !== "ready" ? [{ ...target, preview }] : [];
  });
  const missing = incoming.filter(({ preview }) => preview.state === "fetchRequired");
  const needsFetch = missing.some((target) => !failed[identity(target)]);
  const fetch = async () => {
    if (!missing.length || fetching) return;
    setFetching(true);
    try {
      const results = await runRemoteRound(
        missing.map((target) => ({
          repo: target.repo,
          op: { op: "fetchPushTarget" as const, selection: target.selection },
        })),
      );
      if (!results) return;
      const errors = new Set(
        results.map(({ target }) => identity({ repo: target.repo, selection: target.op.selection })),
      );
      setFailed((old) => {
        const next = { ...old };
        for (const target of missing) next[identity(target)] = errors.has(identity(target));
        return next;
      });
      if (results.length < missing.length) recheck((value) => value + 1);
    } finally {
      setFetching(false);
    }
  };
  return { incoming, resultOf, needsFetch, fetching, fetch, fetchFailed: !needsFetch && missing.length > 0, missing };
}

export function selectedPushOperation(
  selection: InspectionTarget,
  options: { forceWithLease: boolean; setUpstream: boolean; noVerify: boolean; tags: PushTags | null },
  inspected?: PushInspection,
): Extract<PushOp, { op: "pushSelected" }> {
  return {
    op: "pushSelected",
    selection: selection.selection,
    force_with_lease: options.forceWithLease,
    set_upstream: options.setUpstream && !!selection.selection.branch && !selection.selection.revision,
    no_verify: options.noVerify,
    tags: options.tags,
    ...(inspected ? { inspected } : {}),
  };
}

interface PushInspectionBannerProps {
  inspection: ReturnType<typeof usePushInspection>;
  forceAllowed: boolean;
  onUpdate: () => void;
  onShowLog: () => void;
}

async function canUpdatePushSources(targets: readonly InspectionTarget[]): Promise<boolean> {
  const eligibility = await Promise.all(
    targets.map(async ({ repo, selection }) => {
      const info = await call(commands.vcsBranchInfo(repo)).catch(() => null);
      return pushesCurrentUpstream(selection, info);
    }),
  );
  return eligibility.every(Boolean);
}

export function pushesCurrentUpstream(selection: PushSelection, info: BranchInfo | null): boolean {
  if (
    selection.revision !== null ||
    selection.specialRef ||
    !info?.head ||
    info.head !== selection.branch ||
    info.operation
  )
    return false;
  const tracking = info.upstreamTracking;
  return tracking
    ? tracking.remote === selection.remote && tracking.branch === selection.target
    : info.upstream === `${selection.remote}/${selection.target}`;
}

export function PushInspectionBanner({ inspection, forceAllowed, onUpdate, onShowLog }: PushInspectionBannerProps) {
  const { incoming, missing, fetchFailed, fetching, fetch } = inspection;
  const version = useVcs((s) => s.version);
  const updateKey =
    incoming.length &&
    incoming.every(({ selection }) => selection.branch && selection.revision === null && !selection.specialRef)
      ? JSON.stringify(incoming.map(({ repo, selection }) => ({ repo, selection })))
      : null;
  const [updateCheck, setUpdateCheck] = useState<{ key: string; version: number; allowed: boolean } | null>(null);
  useEffect(() => {
    if (!updateKey) return;
    let active = true;
    const project = useProject.getState().project;
    void canUpdatePushSources(JSON.parse(updateKey) as InspectionTarget[]).then((allowed) => {
      if (active && useProject.getState().project === project) setUpdateCheck({ key: updateKey, version, allowed });
    });
    return () => {
      active = false;
    };
  }, [updateKey, version]);
  const update = async () => {
    if (!updateKey) return;
    const project = useProject.getState().project;
    const allowed = await canUpdatePushSources(JSON.parse(updateKey) as InspectionTarget[]);
    if (useProject.getState().project !== project) return;
    if (allowed) onUpdate();
    else setUpdateCheck({ key: updateKey, version, allowed: false });
  };
  if (!incoming.length) return null;
  const count = incoming.reduce((sum, entry) => sum + entry.preview.remoteCommits, 0);
  const single = incoming.length === 1 ? incoming[0] : null;
  const destination = single ? `${single.selection.remote}/${single.selection.target}` : "";
  const text = missing.length
    ? fetchFailed
      ? tx("Could not fetch the remote commits.")
      : tx("Fetch the remote commits before pushing.")
    : single
      ? count === 1
        ? tx`"${destination}" has one commit outside the push source.`
        : tx`"${destination}" has ${count} commits outside the push source.`
      : tx`The selected destinations have ${count} remote commits outside the push sources.`;
  return (
    <div className={`${styles.banner} ${styles.pushWarning}`}>
      <span role="status">
        {text}
        {!missing.length && forceAllowed && <> {tx("Force Push replaces these commits.")}</>}
      </span>
      {fetchFailed && (
        <button type="button" className={styles.linkButton} disabled={fetching} onClick={() => void fetch()}>
          {tx("Retry Fetch")}
        </button>
      )}
      {!missing.length && (
        <button type="button" className={styles.linkButton} onClick={onShowLog}>
          {tx("Show in Git Log")}
        </button>
      )}
      {updateCheck?.allowed && updateCheck.key === updateKey && updateCheck.version === version && (
        <button type="button" className={styles.linkButton} disabled={fetching} onClick={() => void update()}>
          {tx("Update Project")}
        </button>
      )}
    </div>
  );
}

export async function showInspectedCommits(incoming: ReturnType<typeof usePushInspection>["incoming"]) {
  const { emptyFilters, openLogTab } = await import("./logStore");
  const repoRanges = Object.fromEntries(
    incoming.flatMap(({ repo, preview }) =>
      repo && preview.remoteTip ? [[repo, `${preview.localTip}..${preview.remoteTip}`]] : [],
    ),
  );
  openLogTab("log", tx("Remote Commits"), "toolWindow", Object.keys(repoRanges), { ...emptyFilters(), repoRanges });
  toolWindowService().show("git", true);
}
