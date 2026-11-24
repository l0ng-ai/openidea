import type { ChangedFile } from "@/bindings";
import type { ChangeNode } from "./changes";
import { GROUP_LABEL } from "./changes";
import type { AmendPreview } from "./commitStore";
import { commitFileDiffData } from "./diffInput";
import { buildFileTree, type FileTreeNode } from "./fileTree";
import { flatFileNodes } from "./logChanges";
import { dirName } from "./model";

export function amendPreviewNode(
  preview: AmendPreview | null,
  groupByDir: boolean,
  roots: readonly string[],
  headId: string | null | undefined,
): ChangeNode | null {
  if (!preview || roots.length !== 1 || roots[0] !== preview.root) return null;
  if (preview.status === "loading")
    return { key: "amend:loading", type: "group", group: "amend", label: GROUP_LABEL.amend, files: [] };
  if (headId !== undefined && headId !== preview.expectedHead) return null;

  const commit = { ...preview.head, repo: preview.root };
  const keyPrefix = `amend:${preview.root}:${commit.id}`;
  const convert = ({ key, name, file, count, children }: FileTreeNode<ChangedFile>): ChangeNode => {
    const diff = file ? commitFileDiffData(commit, file) : undefined;
    return {
      key: `${keyPrefix}:${key}`,
      label: name,
      type: file ? "file" : "dir",
      group: "amend",
      files: [],
      children: file ? undefined : children.map(convert),
      historicalDiff: diff,
      historicalFileCount: count,
      path: diff?.path,
      kind: file?.kind,
      detail: file ? (file.oldPath ? `← ${file.oldPath}` : groupByDir ? undefined : dirName(file.path)) : undefined,
    };
  };
  const tree = (groupByDir ? buildFileTree : flatFileNodes)(preview.files, (file) => file.path);
  return {
    key: keyPrefix,
    type: "group",
    group: "amend",
    label: commit.summary,
    detail: commit.shortId,
    warning: preview.differentCommitter ? "Committer of the amended commit differs from default" : undefined,
    historicalFileCount: preview.files.length,
    files: [],
    children: tree.map(convert),
  };
}
