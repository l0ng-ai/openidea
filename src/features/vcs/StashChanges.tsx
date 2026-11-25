import { useEffect, useMemo, useRef, useState } from "react";
import type { Stash } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, registerKeyClaim } from "@/platform/keymap";
import { dirname } from "@/platform/project";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { Dialog, IconButton, Tree, fileIconName, showContextMenu } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { openDialog } from "./dialogs";
import { useCommit } from "./commitStore";
import { vcsDiffInFront } from "./diffInput";
import type { FileTreeNode } from "./fileTree";
import { canApplySelectedChanges, filesUnder, flatFileNodes, toLogChanges, type LogChange } from "./logChanges";
import { KIND_COLOR } from "./model";
import { focusStashDiff, showStashDiff, type StashDiffRequest } from "./stashDiff";
import styles from "./CommitView.module.css";

export type StashEntry = Stash & { repo: string | null };

export function showStashChanges(stash: StashEntry) {
  const ref = `stash@{${stash.index}}`;
  const review = new AbortController();
  openDialog((close) => (
    <Dialog
      open
      title={tx`Paths Affected by ${ref}`}
      onClose={() => {
        review.abort();
        close();
      }}
      resizable="both"
      initialSize={{ w: 680, h: 420 }}
      minWidth={360}
      minHeight={240}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <StashChanges stash={stash} dialogLifetime={review.signal} />
    </Dialog>
  ));
}

/** A stash's tracked changes and its separate snapshot of untracked files. */
async function stashFiles(repo: string | null, id: string, base: string | null, untracked?: string | null) {
  const changes = async (revision: string, parents: string[]) => {
    const files = await call(commands.vcsCommitFiles(repo, revision));
    return toLogChanges(files, { id: revision, shortId: revision.slice(0, 8), parents }, repo);
  };
  const [tracked, added] = await Promise.all([
    changes(id, base ? [base] : []),
    untracked ? changes(untracked, []) : Promise.resolve([]),
  ]);
  return { tracked, added };
}

export function StashChanges({ stash, dialogLifetime }: { stash: StashEntry; dialogLifetime?: AbortSignal }) {
  const rowHeight = useRowHeight(22);
  const { repo, id, base, untracked } = stash;
  const target = useWorkflowSettings((settings) => settings.vcs.git.stashDiffTarget);
  const [files, setFiles] = useState<Awaited<ReturnType<typeof stashFiles>>>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewRequest = useRef<AbortController | null>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void stashFiles(repo, id, base, untracked)
      .then((next) => {
        if (live) setFiles(next);
      })
      .catch((err) => {
        if (live) setError(String(err));
      });
    return () => {
      live = false;
    };
  }, [repo, id, base, untracked]);

  useEffect(
    () => () => {
      clearTimeout(previewTimer.current);
      previewRequest.current?.abort();
    },
    [repo, id, target],
  );

  const roots = useMemo(() => {
    if (!files) return [];
    const nodes = flatFileNodes(files.tracked, (f) => f.path);
    if (files.added.length) {
      const children = flatFileNodes(files.added, (f) => f.path).map((n) => ({ ...n, key: `untracked:${n.key}` }));
      nodes.push({ key: "untracked", name: "Untracked Files", file: null, count: children.length, children });
    }
    return nodes;
  }, [files]);
  const all = useMemo(() => filesUnder(roots), [roots]);
  const selection = useMemo(() => filesUnder(roots, selected), [roots, selected]);

  useEffect(() => {
    const request = {
      index: stash.index,
      changes: selection.length ? selection : all,
      chain: selection.length > 1 ? selection : all,
      dialogLifetime,
    };
    if (dialogLifetime) {
      return registerKeyClaim((event, stroke) => {
        if (!(event.target instanceof Node) || !content.current?.contains(event.target)) return false;
        if (!bindingsFor("vcs.showDiff").some((binding) => normalizeBinding(binding) === stroke)) return false;
        event.preventDefault();
        event.stopPropagation();
        void executeAction("vcs.stash.showDiff", request);
        return true;
      });
    }
    if (focused) return focusStashDiff(request);
  }, [focused, stash.index, selection, all, dialogLifetime]);

  const diffSelection = (changes: LogChange[]): StashDiffRequest => ({
    index: stash.index,
    changes,
    chain: changes.length > 1 ? changes : all,
    dialogLifetime,
  });
  const showDiff = (changes: LogChange[]) => {
    clearTimeout(previewTimer.current);
    previewRequest.current?.abort();
    void executeAction("vcs.stash.showDiff", diffSelection(changes));
  };

  return (
    <div
      ref={content}
      className={styles.changes}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Changed files")}>
        <IconButton
          icon="diff"
          title="Show Diff"
          size="small"
          disabled={!all.length}
          onClick={() => showDiff(selection.length ? selection : all)}
        />
        {!dialogLifetime && (
          <IconButton
            icon="check"
            title="Apply Selected Changes"
            size="small"
            disabled={!canApplySelectedChanges(selection)}
            onClick={() => void executeAction("vcs.log.changes.apply", selection)}
          />
        )}
      </div>
      <Tree<FileTreeNode<LogChange>>
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (n.file ? n.name : tx("Untracked Files"))}
        getChildren={(n) => (n.file ? undefined : n.children)}
        isExpandable={(n) => !n.file}
        defaultExpanded={["untracked"]}
        getIcon={(n) => (n.file ? fileIconName(n.name, n.file.path) : "folder")}
        getDetail={(n) => (n.file && n.file.path.includes("/") ? dirname(n.file.path) : undefined)}
        getColor={(n) => (n.file ? KIND_COLOR[n.file.kind === "untracked" ? "added" : n.file.kind] : undefined)}
        aria-label="Changed files"
        rowHeight={rowHeight}
        className={styles.treeWrap}
        empty={<span className={styles.empty}>{error ?? (files ? tx("No changes") : tx("Loading…"))}</span>}
        selected={selected}
        onSelectionChange={(keys, lead) => {
          setSelected(keys);
          clearTimeout(previewTimer.current);
          previewRequest.current?.abort();
          const file = lead?.file;
          if (!dialogLifetime && keys.size === 1 && file && useCommit.getState().diffPreview && !vcsDiffInFront()) {
            const request = new AbortController();
            previewRequest.current = request;
            previewTimer.current = setTimeout(
              () => void showStashDiff(diffSelection([file]), target, request.signal).catch(() => undefined),
              120,
            );
          }
        }}
        onActivate={(node, event) => {
          if (node.file) showDiff(event.type === "keydown" && selection.length > 1 ? selection : [node.file]);
        }}
        onJumpToSource={
          dialogLifetime
            ? undefined
            : (node, keys) =>
                void executeAction(
                  "vcs.log.changes.jumpToSource",
                  keys.has(node.key) ? filesUnder(roots, keys) : filesUnder([node]),
                )
        }
        onContextMenu={(node, keys, event) => {
          if (!node) return;
          const changes = filesUnder(roots, keys);
          if (dialogLifetime) {
            showContextMenu(event, [{ kind: "action", action: "vcs.stash.showDiff", arg: diffSelection(changes) }]);
            return;
          }
          showContextMenu(event, [
            { kind: "action", action: "vcs.stash.showDiff", arg: diffSelection(changes) },
            ...(target === "parent"
              ? [{ kind: "action" as const, action: "vcs.stash.compareWithLocal", arg: diffSelection(changes) }]
              : []),
            {
              kind: "action",
              action: "vcs.log.changes.compareBeforeWithLocal",
              arg: changes,
              disabled: !changes.some((c) => c.before),
            },
            { kind: "separator" },
            {
              kind: "action",
              action: "vcs.log.changes.apply",
              arg: changes,
              disabled: !canApplySelectedChanges(changes),
            },
          ]);
        }}
      />
    </div>
  );
}
