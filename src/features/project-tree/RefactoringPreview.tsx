/**
 * Refactoring Preview for file moves / renames: the files whose references
 * change, each occurrence with its line, and per-file exclusion (IDEA's
 * "Exclude" in the preview). Resolves with the edit to apply, or null.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { FileMove, WorkspaceEdit } from "@/bindings";
import { editorsFor } from "@/editor/api";
import { call, commands, isTauri } from "@/platform/ipc";
import { Checkbox, Dialog, Icon, fileIconName } from "@/ui";
import { nameOf, relativeTo } from "./paths";
import { useProjectTree } from "./store";
import styles from "./FileRefactor.module.css";
import { tx } from "@/platform/i18n";

type EditFile = Extract<WorkspaceEdit["files"][number], { kind: "edit" }>;

interface PreviewRequest {
  title: string;
  edit: WorkspaceEdit;
  moves: FileMove[];
  resolve: (edit: WorkspaceEdit | null) => void;
  seq: number;
}

const usePreview = create<{ request: PreviewRequest | null }>(() => ({ request: null }));

let seq = 0;

export function previewFileRefactoring(opts: Omit<PreviewRequest, "resolve" | "seq">): Promise<WorkspaceEdit | null> {
  usePreview.getState().request?.resolve(null);
  return new Promise((resolve) => {
    usePreview.setState({
      request: {
        ...opts,
        seq: ++seq,
        resolve: (edit) => {
          usePreview.setState({ request: null });
          resolve(edit);
        },
      },
    });
  });
}

async function readLines(path: string): Promise<string[] | null> {
  const open = editorsFor(path)[0];
  if (open) return open.view.state.doc.toJSON();
  if (!isTauri()) return null;
  try {
    return (await call(commands.fsReadText(path))).split(/\r\n?|\n/);
  } catch {
    return null;
  }
}

function FileGroup({
  file,
  root,
  included,
  onToggle,
}: {
  file: EditFile;
  root: string;
  included: boolean;
  onToggle: (on: boolean) => void;
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void readLines(file.path).then((l) => live && setLines(l));
    return () => {
      live = false;
    };
  }, [file.path]);
  const sorted = [...file.edits].sort(
    (a, b) => a.range.start.line - b.range.start.line || a.range.start.col - b.range.start.col,
  );
  return (
    <li className={styles.previewFile}>
      <div className={styles.previewFileRow}>
        <Checkbox checked={included} onChange={onToggle} aria-label={tx`Include ${nameOf(file.path)}`} />
        <Icon name={fileIconName(nameOf(file.path))} size={14} />
        <span className={styles.previewName}>{nameOf(file.path)}</span>
        <span className={styles.previewPath}>{relativeTo(root, file.path) || file.path}</span>
        <span className={styles.spacer} />
        <span className={styles.previewCount}>
          {file.edits.length} {file.edits.length === 1 ? "occurrence" : "occurrences"}
        </span>
      </div>
      <ul className={styles.previewOccurrences}>
        {sorted.slice(0, 50).map((e, i) => {
          const text = lines?.[e.range.start.line] ?? "";
          const end = e.range.end.line === e.range.start.line ? e.range.end.col : text.length;
          const lead = text.length - text.trimStart().length;
          const from = Math.max(0, e.range.start.col - lead);
          const to = Math.max(from, end - lead);
          const t = text.trim();
          return (
            <li key={i} className={styles.previewLineRow}>
              <span className={styles.previewLineNo}>{e.range.start.line + 1}</span>
              <span className={styles.previewCode}>
                {t.slice(0, from)}
                <del className={styles.previewOld}>{t.slice(from, to)}</del>
                <ins className={styles.previewNew}>{e.new_text}</ins>
                {t.slice(to)}
              </span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** Overlay contribution rendering the pending preview. */
export function RefactoringPreviewHost() {
  const request = usePreview((s) => s.request);
  useEffect(() => () => usePreview.getState().request?.resolve(null), []);
  return request ? <PreviewDialog key={request.seq} request={request} /> : null;
}

function PreviewDialog({ request }: { request: PreviewRequest }) {
  const root = useProjectTree((s) => s.root ?? "");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const files = request.edit.files.filter((f): f is EditFile => f.kind === "edit");
  const kept = files.filter((f) => !excluded.has(f.path));
  const occurrences = kept.reduce((n, f) => n + f.edits.length, 0);
  return (
    <Dialog
      open
      title={tx`Refactoring Preview: ${request.title}`}
      onClose={() => request.resolve(null)}
      width={680}
      buttons={[
        {
          label: "Do Refactor",
          role: "default",
          autoFocus: true,
          onClick: () => request.resolve({ ...request.edit, files: kept }),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.previewSummary}>
        {tx`References to update: ${occurrences === 1 ? tx`${occurrences} occurrence` : tx`${occurrences} occurrences`} in ${kept.length === 1 ? tx`${kept.length} file` : tx`${kept.length} files`}`}
      </div>
      <ul className={styles.previewList} aria-label={tx("Changes")}>
        {files.map((f) => (
          <FileGroup
            key={f.path}
            file={f}
            root={root}
            included={!excluded.has(f.path)}
            onToggle={(on) =>
              setExcluded((s) => {
                const next = new Set(s);
                if (on) next.delete(f.path);
                else next.add(f.path);
                return next;
              })
            }
          />
        ))}
      </ul>
    </Dialog>
  );
}
