/**
 * The Merge tool window (#3572): pick the source branch and the branch the merge lands
 * on (local, or a remote one such as `origin/develop`), see what it brings in before
 * running it, and open the merge request page afterwards.
 */
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type { Branch } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Button, Checkbox, Input, List, Select, Spinner, T, tooltipAttrs } from "@/ui";
import { registerToolWindow } from "@/workbench/contributions";
import { hideToolWindow, showToolWindow } from "@/workbench/toolwindows/store";
import { sortLocal, sortRemote } from "./branches";
import { MergeFlags, mergeOptionsOf, type MergeFlag } from "./gitMenuDialogs";
import { localBranchFor, mergeRequestUrl, parseTarget, targetOptions } from "./mergeRequest";
import { mergeIntoTarget, remoteUrlOf } from "./mergeInto";
import { PREVIEW_LIMIT, loadMergePreview, type MergePreview } from "./mergePreview";
import { RepoPicker, useBranchInfo } from "./gitMenuDialogs";
import { openUrl } from "./issueLinks";
import { currentRepo } from "./store";
import styles from "./common.module.css";

interface MergeWindowState {
  /** Repository the window was opened on; `undefined` keeps the selected one. */
  repo: string | null | undefined;
  open: (repo?: string | null) => void;
}

export const useMergeWindow = create<MergeWindowState>()((set) => ({
  repo: undefined,
  open: (repo) => set({ repo }),
}));

let disposeMergeWindow: (() => void) | null = null;

/** `Git › Merge…`: the merge opens in the sidebar tool window, not in a dialog. */
export function showMergeTool(repo?: string | null) {
  useMergeWindow.getState().open(repo);
  disposeMergeWindow ??= registerToolWindow({
    id: "merge",
    title: "Merge",
    icon: "branch",
    anchor: "right",
    order: 4,
    component: () => <MergePane initialRepo={useMergeWindow.getState().repo} />,
  });
  showToolWindow("merge", true);
}

function useRepoBranches(repo: string | null): Branch[] {
  const [branches, setBranches] = useState<Branch[]>([]);
  useEffect(() => {
    let live = true;
    void call(commands.vcsBranches(repo))
      .then((list) => live && setBranches(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo]);
  return branches;
}

const branchOptionsOf = (list: readonly Branch[]) =>
  list.filter((b) => !b.name.endsWith("/HEAD")).map((b) => ({ value: b.name, label: b.name, icon: "branch" }));

/** The merge window's body; `initialRepo` also makes it testable without the sidebar. */
export function MergePane({ initialRepo }: { initialRepo?: string | null }) {
  const [repo, setRepo] = useState(() => (initialRepo === undefined ? currentRepo() : initialRepo));
  const info = useBranchInfo(repo);
  const branches = useRepoBranches(repo);
  const head = info?.head ?? null;
  const [source, setSource] = useState<string | null>(null);
  const [targetRef, setTargetRef] = useState("");
  const [flags, setFlags] = useState<Set<MergeFlag>>(() => new Set());
  const [withMessage, setWithMessage] = useState(false);
  const [message, setMessage] = useState("");
  const [fetchFirst, setFetchFirst] = useState(true);
  const [loaded, setLoaded] = useState<{ key: string; data: MergePreview | null } | null>(null);
  const [mrUrl, setMrUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sources = useMemo(
    () => [...branchOptionsOf(sortLocal(branches).filter((b) => !b.current)), ...branchOptionsOf(sortRemote(branches))],
    [branches],
  );
  const target = useMemo(() => parseTarget(targetRef, branches), [targetRef, branches]);
  const targetRev = target.kind === "current" ? head : target.name;
  const intoRemote = target.kind === "remote";

  const previewKey = source && targetRev ? `${repo}|${source}|${targetRev}` : null;
  const preview = loaded?.key === previewKey ? loaded.data : null;

  useEffect(() => {
    if (!previewKey || !source || !targetRev) return;
    let live = true;
    loadMergePreview(repo, source, targetRev)
      .then((data) => live && setLoaded({ key: previewKey, data }))
      .catch(() => live && setLoaded({ key: previewKey, data: null }));
    return () => {
      live = false;
    };
  }, [previewKey, repo, source, targetRev]);

  const chooseSource = (name: string | null) => {
    setSource(name);
    setMrUrl(null);
  };

  const chooseTarget = (value: string) => {
    setTargetRef(value);
    setMrUrl(null);
  };

  const chooseRepo = (root: string) => {
    if (root === repo) return;
    setRepo(root);
    setSource(null);
    setTargetRef("");
    setMrUrl(null);
  };

  const merge = async () => {
    if (!source) return;
    setBusy(true);
    try {
      const merged = await mergeIntoTarget({
        repo,
        source,
        target,
        options: mergeOptionsOf(flags, withMessage ? message : null),
        branches,
        fetch: fetchFirst,
      });
      if (!merged || target.kind !== "remote") return;
      const url = mergeRequestUrl(await remoteUrlOf(repo, target.remote), source, target.branch);
      setMrUrl(url);
      if (url) await openUrl(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.form} style={{ padding: 10, gap: 8, overflow: "auto" }}>
      <RepoPicker repo={repo} onChange={chooseRepo} />
      <div className={styles.fieldLabel}>
        <T>Branch to merge:</T>
      </div>
      <Select
        aria-label="Branch to merge"
        value={source}
        placeholder="Select branch"
        options={sources}
        onChange={chooseSource}
        searchable
      />
      <div className={styles.fieldLabel}>
        <T>Merge into:</T>
      </div>
      <Select
        aria-label="Merge into"
        value={targetRef}
        placeholder={head ? `Current branch (${head})` : "Current branch"}
        options={targetOptions(branches, head, source)}
        onChange={chooseTarget}
        searchable
      />
      <Preview preview={preview} source={source} target={targetRev} />
      <div className={styles.fieldLabel}>
        <T>Options:</T>
      </div>
      <MergeFlags on={flags} setOn={setFlags} />
      <Checkbox label="-m (commit message)" checked={withMessage} onChange={setWithMessage} />
      {withMessage && (
        <Input
          aria-label="Commit message"
          value={message}
          placeholder={source ? tx`Merge branch '${source}' into ${localBranchFor(target) ?? head ?? "HEAD"}` : ""}
          onChange={(e) => setMessage(e.target.value)}
        />
      )}
      <Checkbox
        label={tx`Fetch before merging`}
        checked={fetchFirst && intoRemote}
        disabled={!intoRemote}
        onChange={setFetchFirst}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <Button variant="primary" disabled={!source || busy} onClick={() => void merge()}>
          <T>Merge</T>
        </Button>
        <Button onClick={() => hideToolWindow("merge")}>
          <T>Close</T>
        </Button>
      </div>
      {mrUrl && (
        <Button onClick={() => void openUrl(mrUrl)}>
          <T>Open merge request page</T>
        </Button>
      )}
    </div>
  );
}

function Preview({ preview, source, target }: { preview: MergePreview | null; source: string | null; target: string | null }) {
  if (!source || !target) return null;
  if (!preview)
    return (
      <div className={styles.empty}>
        <Spinner size={14} />
      </div>
    );
  const { ahead, behind, conflicts } = preview;
  return (
    <div className={styles.section} style={{ display: "grid", gap: 4 }}>
      <div className={styles.hint}>
        {ahead.length >= PREVIEW_LIMIT ? `${PREVIEW_LIMIT}+` : ahead.length} <T>commits to merge</T>
        {behind > 0 && <span> · {target} <T>is ahead by</T> {behind}</span>}
      </div>
      {conflicts.length > 0 && (
        <div className={styles.error} role="status">
          <T>Likely conflicts in</T> {conflicts.length} <T>files</T>：
          <div className={styles.fileList} style={{ maxHeight: 90, overflow: "auto" }}>
            {conflicts.slice(0, 50).map((path) => (
              <div key={path} className={styles.mono}>
                {path}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={styles.commitListBody} style={{ maxHeight: 180, overflow: "auto" }}>
        <List
          items={ahead}
          getKey={(c) => c.id}
          rowHeight={22}
          aria-label="Commits to merge"
          empty={
            <span className={styles.empty}>
              <T>Nothing new to merge</T>
            </span>
          }
          renderItem={(c) => (
            <span className={styles.commitRow} style={{ flex: 1, minWidth: 0, padding: 0 }}>
              <span className={styles.commitHash}>{c.shortId}</span>
              <span className={styles.commitSubject} {...tooltipAttrs(c.message || c.summary, undefined, true)}>
                {c.summary}
              </span>
              <span className={styles.commitMeta}>{c.author}</span>
            </span>
          )}
        />
      </div>
    </div>
  );
}
