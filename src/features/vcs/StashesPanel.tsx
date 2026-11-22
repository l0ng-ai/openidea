import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { IconButton, Select, SplitGroup, SplitHandle, SplitPanel, Tree, showContextMenu } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { applyStash, dropStash, stashChanges } from "./changeOps";
import { formatTime, stashLabel } from "./model";
import { StashChanges, type StashEntry } from "./StashChanges";
import { repoName, selectRepo, useVcs } from "./store";
import styles from "./CommitView.module.css";

const stashIdentity = (stash: StashEntry) => JSON.stringify([stash.repo, stash.id, stash.message, stash.timeMs]);
const stashKey = (stash: StashEntry) => `${stash.index}:${stashIdentity(stash)}`;
const EMPTY_STASHES: StashEntry[] = [];

export function StashesPanel({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }) {
  const rowHeight = useRowHeight(22);
  const project = useVcs((s) => s.root);
  const repos = useVcs((s) => s.roots);
  const repo = useVcs((s) => s.repo);
  const version = useVcs((s) => s.version);
  const [tick, setTick] = useState(0);
  const [selectedStash, setSelectedStash] = useState<StashEntry | null>(null);
  const request = useMemo(() => ({ project, repos, repo, version, tick }), [project, repos, repo, version, tick]);
  const [result, setResult] = useState<{ request: typeof request; stashes: StashEntry[]; error: string | null }>();
  const loaded = result?.request === request;
  const sameProject =
    result?.request.project === project && result?.request.repos === repos && result?.request.repo === repo;
  const stashes = sameProject ? result!.stashes : EMPTY_STASHES;
  const selectedIdentity = selectedStash && stashIdentity(selectedStash);
  const matching = selectedIdentity ? stashes.filter((entry) => stashIdentity(entry) === selectedIdentity) : [];
  const current = matching.find((entry) => entry.index === selectedStash?.index) ?? matching[0] ?? stashes[0];
  const selected = useMemo(() => new Set(current ? [stashKey(current)] : []), [current]);

  useEffect(() => {
    let live = true;
    void Promise.all(
      (request.repos.length ? request.repos : [request.repo]).map(async (root) =>
        (await call(commands.vcsStashes(root))).map((s) => ({ ...s, repo: root })),
      ),
    ).then(
      (lists) => {
        if (live) setResult({ request, stashes: lists.flat(), error: null });
      },
      (err) => {
        if (live) setResult({ request, stashes: [], error: String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [request]);

  const stashList = (
    <div className={styles.treeWrap}>
      <Tree<StashEntry>
        roots={stashes}
        getKey={stashKey}
        getLabel={(s) => stashLabel(s.message).text}
        getChildren={() => undefined}
        isExpandable={() => false}
        selected={selected}
        multiSelect={false}
        rowHeight={rowHeight}
        aria-label="Stashes"
        className={styles.stashList}
        empty={<span className={styles.empty}>{loaded ? (result.error ?? tx("No stashes")) : tx("Loading…")}</span>}
        onSelectionChange={(_keys, lead) => setSelectedStash(lead)}
        onContextMenu={(s, _keys, e) => {
          if (!s || !loaded) return;
          setSelectedStash(s);
          showContextMenu(e, [
            { label: "Apply Stash", icon: "check", run: () => void applyStash(s, false, s.repo) },
            { label: "Pop Stash", icon: "undo", run: () => void applyStash(s, true, s.repo) },
            { kind: "action", action: "vcs.unstashAs", arg: s },
            { kind: "separator" },
            { label: "Drop Stash", icon: "trash", run: () => void dropStash(s, s.repo) },
            { kind: "action", action: "vcs.clearStashes", arg: s.repo },
          ]);
        }}
        renderNode={(s) => {
          const { branch, text } = stashLabel(s.message);
          return (
            <span className={styles.stashRow} title={`stash@{${s.index}}: ${s.message}`}>
              <span className={styles.stashMessage}>
                {repos.length > 1 && s.repo ? `${repoName(s.repo)} · ` : ""}
                {text}
              </span>
              {branch && <span className={clsx(styles.detail, styles.stashBranch)}>{branch}</span>}
              <span className={clsx(styles.detail, styles.stashTime)}>{formatTime(s.timeMs)}</span>
            </span>
          );
        }}
      />
    </div>
  );

  return (
    <div className={styles.changes}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Stashes")}>
        {repos.length > 1 && (
          <Select
            aria-label="Repository"
            value={repo}
            onChange={(root) => void selectRepo(root)}
            options={repos.map((root) => ({ value: root, label: repoName(root) }))}
          />
        )}
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => setTick((n) => n + 1)} />
        <IconButton icon="plus" title="Stash Changes…" size="small" onClick={() => void stashChanges()} />
        <span className={styles.sep} />
        <IconButton
          icon="check"
          title="Apply Stash"
          size="small"
          disabled={!current || !loaded}
          onClick={() => current && void applyStash(current, false, current.repo)}
        />
        <IconButton
          icon="undo"
          title="Pop Stash (Apply and Drop)"
          size="small"
          disabled={!current || !loaded}
          onClick={() => current && void applyStash(current, true, current.repo)}
        />
        <IconButton
          icon="trash"
          title="Drop Stash"
          size="small"
          disabled={!current || !loaded}
          onClick={() => current && void dropStash(current, current.repo)}
        />
      </div>
      {current ? (
        <SplitGroup
          orientation={orientation}
          className={styles.split}
          storageKey={`openidea.vcs.stashFilesSplit.${orientation}`}
        >
          <SplitPanel id="stashes" defaultSize="45%" minSize="20%" className={styles.treeWrap}>
            {stashList}
          </SplitPanel>
          <SplitHandle aria-label={tx("Resize stash panes")} />
          <SplitPanel id="files" minSize="25%">
            <StashChanges key={`${stashIdentity(current)}:${tick}`} stash={current} />
          </SplitPanel>
        </SplitGroup>
      ) : (
        stashList
      )}
    </div>
  );
}
