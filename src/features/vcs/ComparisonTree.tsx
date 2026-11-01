import { useState, type ReactNode } from "react";
import { Icon, Tree, fileIconName } from "@/ui";
import { DiffEditor } from "./DiffEditor";
import { diffInput, openDiff, type DiffData } from "./diffInput";
import { dirKeys, type FileTreeNode } from "./fileTree";
import styles from "./common.module.css";

/** Shared changes tree and on-demand diff surface for revisions and disk folders. */
export function ComparisonTree<F>({
  tree,
  current,
  onSelect,
  diffFor,
  renderDetails,
  ariaLabel,
  openOnActivate = false,
  getColor,
  onOpen,
}: {
  tree: FileTreeNode<F>[];
  current: F | null;
  onSelect: (entry: F | null) => void;
  diffFor: (entry: F) => DiffData | null;
  renderDetails: (node: FileTreeNode<F>) => ReactNode;
  ariaLabel: string;
  openOnActivate?: boolean;
  getColor?: (entry: F) => string | undefined;
  onOpen?: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const data = current && diffFor(current);
  const input = data ? diffInput(data) : null;
  return (
    <div className={`${styles.comparison} ${input ? styles.comparisonWithDiff : ""}`}>
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
          const diff = diffFor(entry);
          if (openOnActivate && diff) {
            void openDiff(diff);
            onOpen?.();
          }
        }}
        aria-label={ariaLabel}
        className={styles.comparisonTree}
        renderNode={(n) => (
          <span className={styles.fileRow} style={{ flex: 1, padding: 0 }}>
            <Icon name={n.file ? fileIconName(n.name) : "folder"} size={14} />
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
