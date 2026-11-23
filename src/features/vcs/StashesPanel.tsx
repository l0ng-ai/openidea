import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Icon, IconButton, Select, SplitGroup, SplitHandle, SplitPanel, Tree, showContextMenu } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { applyStash, dropStash, stashChanges } from "./changeOps";
import { formatTime, stashLabel } from "./model";
import { StashChanges, type StashEntry } from "./StashChanges";
import { repoName, selectRepo, useVcs } from "./store";
import styles from "./CommitView.module.css";

const stashIdentity = (stash: StashEntry) => JSON.stringify([stash.repo, stash.id, stash.message, stash.timeMs]);
const stashKey = (stash: StashEntry) => `${stash.index}:${stashIdentity(stash)}`;
const EMPTY_STASHES: StashEntry[] = [];

interface StashGroup {
  repo: string;
  entries: StashEntry[];
}

type StashNode = StashGroup | StashEntry;
const isGroup = (node: StashNode): node is StashGroup => "entries" in node;
const nodeKey = (node: StashNode) => (isGroup(node) ? `repo:${node.repo}` : stashKey(node));

export function StashesPanel({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }) {
  const rowHeight = useRowHeight(22);
  const project = useVcs((s) => s.root);
  const repos = useVcs((s) => s.roots);
  const repo = useVcs((s) => s.repo);
  const version = useVcs((s) => s.version);
  const [tick, setTick] = useState(0);
  const [selection, setSelection] = useState<StashNode | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const request = useMemo(() => ({ project, repos, repo, version, tick }), [project, repos, repo, version, tick]);
  const [result, setResult] = useState<{ request: typeof request; stashes: StashEntry[]; error: string | null }>();
  const loaded = result?.request === request;
  const sameProject =
    result?.request.project === project && result?.request.repos === repos && result?.request.repo === repo;
  const stashes = sameProject ? result!.stashes : EMPTY_STASHES;
  const groups = useMemo(() => {
    const byRepo = new Map<string, StashGroup>();
    if (repos.length > 1) {
      for (const stash of stashes) {
        if (!stash.repo) continue;
        let group = byRepo.get(stash.repo);
        if (!group) byRepo.set(stash.repo, (group = { repo: stash.repo, entries: [] }));
        group.entries.push(stash);
      }
    }
    return [...byRepo.values()];
  }, [repos.length, stashes]);
  const expanded = useMemo(
    () => new Set(groups.filter((group) => !collapsed.has(group.repo)).map(nodeKey)),
    [groups, collapsed],
  );
  const selectedGroup = selection && isGroup(selection) ? groups.find((group) => group.repo === selection.repo) : null;
  const selectedStash = selection && !isGroup(selection) ? selection : null;
  const selectedIdentity = selectedStash && stashIdentity(selectedStash);
  const matching = selectedIdentity ? stashes.filter((entry) => stashIdentity(entry) === selectedIdentity) : [];
  const current = selectedGroup
    ? undefined
    : (matching.find((entry) => entry.index === selectedStash?.index) ??
      matching[0] ??
      stashes.find((entry) => !groups.length || !entry.repo || !collapsed.has(entry.repo)));
  const selectedNode = selectedGroup ?? current;
  const selected = useMemo(() => new Set(selectedNode ? [nodeKey(selectedNode)] : []), [selectedNode]);

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
      <Tree<StashNode>
        roots={groups.length ? groups : stashes}
        getKey={nodeKey}
        getLabel={(node) => (isGroup(node) ? repoName(node.repo) : stashLabel(node.message).text)}
        getChildren={(node) => (isGroup(node) ? node.entries : undefined)}
        isExpandable={isGroup}
        expanded={expanded}
        onExpandedChange={(_keys, node, open) => {
          if (!isGroup(node)) return;
          setCollapsed((keys) => {
            const next = new Set(keys);
            if (open) next.delete(node.repo);
            else next.add(node.repo);
            return next;
          });
          if (!open && current?.repo === node.repo) setSelection(node);
        }}
        selected={selected}
        multiSelect={false}
        rowHeight={rowHeight}
        aria-label="Stashes"
        className={styles.stashList}
        empty={<span className={styles.empty}>{loaded ? (result.error ?? tx("No stashes")) : tx("Loading…")}</span>}
        onSelectionChange={(_keys, lead) => setSelection(lead)}
        onContextMenu={(s, _keys, e) => {
          if (!s || isGroup(s) || !loaded) return;
          setSelection(s);
          showContextMenu(e, [
            { label: "Apply Stash", icon: "check", run: () => void applyStash(s, false, s.repo) },
            { label: "Pop Stash", icon: "undo", run: () => void applyStash(s, true, s.repo) },
            { kind: "action", action: "vcs.unstashAs", arg: s },
            { kind: "separator" },
            { label: "Drop Stash", icon: "trash", run: () => void dropStash(s, s.repo) },
            { kind: "action", action: "vcs.clearStashes", arg: s.repo },
          ]);
        }}
        renderNode={(node) => {
          if (isGroup(node)) {
            return (
              <span className={styles.stashRow} title={node.repo}>
                <Icon name="toolwindow-git" size={16} />
                <span className={styles.stashGroupName}>{repoName(node.repo)}</span>
                <span className={styles.nodeCount}>{node.entries.length}</span>
              </span>
            );
          }
          const { branch, text } = stashLabel(node.message);
          const time = formatTime(node.timeMs);
          return (
            <span
              className={styles.stashRow}
              title={[`stash@{${node.index}}: ${node.message}`, time].filter(Boolean).join("\n")}
            >
              <span className={styles.stashMessage}>{text}</span>
              {time && <span className={styles.stashTime}>{time}</span>}
              {branch && <span className={clsx(styles.detail, styles.stashBranch)}>{branch}</span>}
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
      {stashes.length > 0 ? (
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
            {current ? (
              <StashChanges key={`${stashIdentity(current)}:${tick}`} stash={current} />
            ) : (
              <span className={styles.empty}>{tx("Select a stash to view its changes.")}</span>
            )}
          </SplitPanel>
        </SplitGroup>
      ) : (
        stashList
      )}
    </div>
  );
}
