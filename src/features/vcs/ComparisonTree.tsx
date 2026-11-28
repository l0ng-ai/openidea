import { useRef, useState, type ReactNode } from "react";
import { Icon, Tree, fileIconName, lazyComponent } from "@/ui";
import { diffInput, openVcsDiff, withChain, type DiffData } from "./diffInput";
import { useDiffSource } from "./diffSource";
import { dirKeys, type FileTreeNode } from "./fileTree";
import { filesUnder } from "./logChanges";
import styles from "./common.module.css";

const DiffEditor = lazyComponent(() => import("./DiffEditor").then((m) => m.DiffEditor));
const defaultOpenDiff = (diff: DiffData) => void openVcsDiff(diff);

/** `file`'s diff with the tree's other files as its chain, in display order: F7 goes on to the next file (IDEA). */
export function chainedDiff<F>(
  tree: readonly FileTreeNode<F>[],
  file: F,
  diffFor: (entry: F) => DiffData | null,
): DiffData | null {
  const files = filesUnder(tree).filter((f) => diffFor(f));
  const index = files.indexOf(file);
  return index < 0
    ? diffFor(file)
    : withChain(
        files.map((f) => diffFor(f)!),
        index,
      );
}

/** Shared changes tree and on-demand diff surface for revisions and disk folders. */
export function ComparisonTree<F>({
  tree,
  current,
  onSelect,
  diffFor,
  renderFileIcon,
  renderDetails,
  ariaLabel,
  openOnActivate = false,
  getColor,
  onOpen,
  inlineDiff = true,
  openDiff = defaultOpenDiff,
  onShowDiff,
}: {
  tree: FileTreeNode<F>[];
  current: F | null;
  onSelect: (entry: F | null) => void;
  diffFor: (entry: F) => DiffData | null;
  renderFileIcon?: (file: F) => ReactNode;
  renderDetails: (node: FileTreeNode<F>) => ReactNode;
  ariaLabel: string;
  openOnActivate?: boolean;
  getColor?: (entry: F) => string | undefined;
  onOpen?: () => void;
  /** Show the selected file's diff beside the tree; off where there is no room (a sidebar). */
  inlineDiff?: boolean;
  /** With `openOnActivate`: where a double-clicked file's diff opens (default: an editor tab). */
  openDiff?: (diff: DiffData) => void;
  /**
   * Show Diff on the tree's selection, as the owner's Show Diff button does. Without it the
   * file's diff, with the tree's files as its chain, goes to `openDiff`. Show Diff in New
   * Window opens that diff in a diff window either way (the tree is a {@link useDiffSource}).
   */
  onShowDiff?: (file: F) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  // The lead file, else the first file under the selected rows, else the tree's first file.
  const pick = (): F | undefined => {
    const all = filesUnder(tree);
    return (current !== null && all.includes(current) ? current : undefined) ?? filesUnder(tree, selected)[0] ?? all[0];
  };
  useDiffSource(root, {
    diff: () => {
      const file = pick();
      return file === undefined ? null : chainedDiff(tree, file, diffFor);
    },
    show: () => {
      const file = pick();
      if (file === undefined) return;
      if (onShowDiff) return onShowDiff(file);
      const diff = chainedDiff(tree, file, diffFor);
      if (!diff) return;
      openDiff(diff);
      onOpen?.();
    },
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const data = inlineDiff && current && diffFor(current);
  const input = data ? diffInput(data) : null;
  return (
    <div ref={root} className={`${styles.comparison} ${input ? styles.comparisonWithDiff : ""}`}>
      <Tree<FileTreeNode<F>>
        roots={tree}
        getKey={(n) => n.key}
        getLabel={(n) => n.name}
        getChildren={(n) => (n.file ? undefined : n.children)}
        isExpandable={(n) => !n.file}
        expanded={expanded ?? new Set(dirKeys(tree))}
        onExpandedChange={setExpanded}
        selected={selected}
        onSelectionChange={(sel, lead) => {
          setSelected(sel);
          onSelect(lead?.file ?? lead?.directory ?? null);
        }}
        onActivate={(n) => {
          const entry = n.file ?? n.directory;
          if (!entry) return;
          onSelect(entry);
          const diff = n.file ? chainedDiff(tree, n.file, diffFor) : diffFor(entry);
          if (openOnActivate && diff) {
            openDiff(diff);
            onOpen?.();
          }
        }}
        aria-label={ariaLabel}
        className={styles.comparisonTree}
        renderNode={(n) => (
          <span className={styles.fileRow} style={{ flex: 1, padding: 0 }}>
            {(n.file && renderFileIcon?.(n.file)) ?? <Icon name={n.file ? fileIconName(n.name) : "folder"} size={14} />}
            <span className={styles.fileName} style={{ color: n.file ? getColor?.(n.file) : undefined }}>
              {n.name}
            </span>
            {renderDetails(n)}
          </span>
        )}
      />
      {input && (
        <div className={styles.comparisonDiff}>
          <DiffEditor key={input.key} input={input} />
        </div>
      )}
    </div>
  );
}
