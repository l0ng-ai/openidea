/**
 * The commits and changes of the new pull request (`GHPRCreateComponentFactory.changesPanel`):
 * "Changes" / "Changes from" with the commit chooser ("{n} commits", "All commits (n)"),
 * the selected commit's details (Show / Hide details) and the changes tree, whose
 * Show Diff opens the files in the diff viewer as one chain.
 */
import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { buildFileTree, dirKeys, type FileTreeNode } from "@/features/vcs/fileTree";
import { openDiff, withChain } from "@/features/vcs/diffInput";
import { KIND_COLOR, baseName, fileCount, type EffectiveKind } from "@/features/vcs/model";
import type { Commit } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Icon, IconButton, Spinner, T, Tree, fileIconName, showContextMenu, type MenuItem } from "@/ui";
import { ChooserPopup } from "../ui/ChooserPopup";
import { prettyDateTime } from "../ui/prettyDate";
import { commitDescription } from "./model";
import { selectCommit, useCreatePr, type CreateChange } from "./store";
import styles from "./Create.module.css";

function Centered({ children, error }: { children: ReactNode; error?: boolean }) {
  return <div className={error ? `${styles.centered} ${styles.errorText}` : styles.centered}>{children}</div>;
}

export function ChangesPanel() {
  const commits = useCreatePr((s) => s.commits);
  if (!commits)
    return (
      <Centered>
        <T>Select pull request base and head to view changes</T>
      </Centered>
    );
  if (commits.state === "loading")
    return (
      <Centered>
        <Spinner size={14} />
      </Centered>
    );
  if (commits.state === "error")
    return (
      <Centered error>
        <div>
          <T>Failed to load commits</T>
        </div>
        <div className={styles.errorDetail}>{commits.error}</div>
      </Centered>
    );
  if (!commits.value.length)
    return (
      <Centered>
        <span className={styles.hint}>
          <T>Pull request does not contain any commits</T>
        </span>
      </Centered>
    );
  return <CommitsAndChanges commits={commits.value} />;
}

function CommitsAndChanges({ commits }: { commits: Commit[] }) {
  const selectedId = useCreatePr((s) => s.selectedCommit);
  const index = commits.findIndex((c) => c.id === selectedId);
  const selected = index >= 0 ? commits[index]! : null;
  return (
    <div className={styles.changes}>
      <div className={styles.commits}>
        <div className={styles.commitsHeader}>
          <span className={styles.commitsTitle}>{commits.length === 1 ? tx("Changes") : tx("Changes from")}</span>
          <CommitChooser commits={commits} selected={selected} />
          {commits.length > 1 && selected && (
            <>
              <IconButton
                icon="arrow-down"
                size="small"
                title="Next Commit"
                disabled={index === commits.length - 1}
                onClick={() => selectCommit(commits[index + 1]!.id)}
              />
              <IconButton
                icon="arrow-up"
                size="small"
                title="Previous Commit"
                disabled={index === 0}
                onClick={() => selectCommit(commits[index - 1]!.id)}
              />
            </>
          )}
        </div>
        {selected && <CommitDetails key={selected.id} commit={selected} />}
      </div>
      <ChangesTree />
    </div>
  );
}

function CommitChooser({ commits, selected }: { commits: Commit[]; selected: Commit | null }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const items = useMemo<Array<Commit | null>>(() => [null, ...commits], [commits]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.link}
        disabled={commits.length <= 1}
        onClick={() => setOpen(true)}
      >
        <span className={selected ? styles.hash : undefined}>
          {selected ? selected.shortId : tx`${commits.length} commits`}
        </span>
        {commits.length > 1 && <Icon name="chevron-down" size={12} />}
      </button>
      {open && (
        <ChooserPopup<Commit | null>
          mode="single"
          anchor={ref}
          items={items}
          getKey={(c) => c?.id ?? "all"}
          present={(c) =>
            c
              ? {
                  text: c.summary,
                  detail: `${c.author}, ${c.timeMs ? prettyDateTime(c.timeMs) : ""}`,
                  icon: selected?.id === c.id ? "check" : "commit",
                }
              : { text: tx`All commits (${commits.length})`, icon: selected ? "commit" : "check" }
          }
          placeholder="Search commits"
          aria-label="Commits"
          width={360}
          onChoose={(c) => selectCommit(c?.id ?? null)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** `CodeReviewDetailsCommitInfoComponentFactory`: the subject, and with the details the body, author and date. */
function CommitDetails({ commit }: { commit: Commit }) {
  const [details, setDetails] = useState(false);
  const description = commitDescription(commit.message);
  return (
    <div className={styles.commitInfo}>
      <div className={styles.commitTop}>
        <span className={details ? styles.commitSubjectFull : styles.commitSubject}>{commit.summary}</span>
        <button type="button" className={styles.textLink} onClick={() => setDetails((d) => !d)}>
          {details ? tx("Hide details") : tx("Show details")}
        </button>
      </div>
      {details && description && <div className={styles.commitBody}>{description}</div>}
      {details && (
        <div className={styles.commitMeta}>
          {commit.author}, {commit.timeMs ? prettyDateTime(commit.timeMs) : ""}
        </div>
      )}
    </div>
  );
}

const kindOf = (c: CreateChange): EffectiveKind => (c.kind === "untracked" ? "added" : c.kind);

/** Show Diff: `first` with every file of the tree in the chain (F7 moves along). */
function showDiff(all: readonly CreateChange[], first: CreateChange) {
  void openDiff(
    withChain(
      all.map((c) => c.diff),
      Math.max(0, all.indexOf(first)),
    ),
  );
}

function ChangesTree() {
  const changes = useCreatePr((s) => s.changes);
  const files = changes?.state === "ok" ? changes.value : null;
  const roots = useMemo(() => (files ? buildFileTree(files, (f) => f.path) : []), [files]);
  const expanded = useMemo(() => dirKeys(roots), [roots]);
  const ordered = useMemo(() => {
    const out: CreateChange[] = [];
    const walk = (ns: readonly FileTreeNode<CreateChange>[]) =>
      ns.forEach((n) => (n.file ? out.push(n.file) : walk(n.children)));
    walk(roots);
    return out;
  }, [roots]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  if (!changes || changes.state === "loading")
    return (
      <Centered>
        <Spinner size={14} />
      </Centered>
    );
  if (changes.state === "error")
    return (
      <Centered error>
        <div>
          <T>Failed to load changes</T>
        </div>
        <div className={styles.errorDetail}>{changes.error}</div>
      </Centered>
    );
  const selectedFiles = (keys: ReadonlySet<string>) => ordered.filter((f) => keys.has(`f:${f.path}`));
  const menu = (node: FileTreeNode<CreateChange> | null, keys: Set<string>, e: MouseEvent) => {
    const picked = selectedFiles(keys);
    const first = picked[0] ?? node?.file ?? null;
    const items: MenuItem[] = [
      { label: "Show Diff", icon: "diff", disabled: !first, run: () => first && showDiff(ordered, first) },
    ];
    showContextMenu(e, items);
  };
  return (
    <Tree<FileTreeNode<CreateChange>>
      key={changes.value.length ? "files" : "empty"}
      className={styles.tree}
      roots={roots}
      getKey={(n) => n.key}
      getLabel={(n) => n.name}
      getChildren={(n) => n.children}
      isExpandable={(n) => !n.file}
      defaultExpanded={expanded}
      selected={selection}
      onSelectionChange={setSelection}
      multiSelect
      rowHeight={22}
      aria-label="Changes"
      speedSearch
      onActivate={(n) => n.file && showDiff(ordered, n.file)}
      onContextMenu={menu}
      empty={
        <Centered>
          <span className={styles.hint}>
            <T>Commit does not contain any changes</T>
          </span>
        </Centered>
      }
      renderNode={(n) => <ChangeRow node={n} />}
    />
  );
}

function ChangeRow({ node }: { node: FileTreeNode<CreateChange> }) {
  if (!node.file)
    return (
      <span className={styles.fileRow}>
        <Icon name="folder" size={16} />
        <span className={styles.fileName}>{node.name}</span>
        <span className={styles.fileDetail}>{fileCount(node.count)}</span>
      </span>
    );
  const f = node.file;
  return (
    <span className={styles.fileRow} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <Icon name={fileIconName(node.name)} size={16} />
      <span className={styles.fileName} style={{ color: KIND_COLOR[kindOf(f)] }}>
        {node.name}
      </span>
      {f.oldPath && <span className={styles.fileDetail}>{tx`renamed from ${baseName(f.oldPath)}`}</span>}
    </span>
  );
}
