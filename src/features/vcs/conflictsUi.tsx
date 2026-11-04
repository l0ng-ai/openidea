/** "Resolve Conflicts" dialog and in-editor conflict resolution actions. */
import { useState } from "react";
import type { FileStatus } from "@/bindings";
import { activeEditor } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { Dialog, Icon, List, fileIconName, T } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { blockAt, parseConflicts, resolutionText, type Resolution } from "./conflicts";
import { openDialog } from "./dialogs";
import { mergeInput } from "./mergeKind";
import { baseName, dirName, relTo, stripSlash } from "./model";
import { controlLabel, controlOperation, inProgress, operationTitle } from "./operations";
import { runOp, writeFileText } from "./ops";
import { executeAction } from "@/platform/actions";
import { conflictedFiles, useVcs } from "./store";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

export function showConflictsDialog() {
  if (!conflictedFiles().length) {
    notifications().notify({ group: "vcs", level: "info", title: "No merge conflicts" });
    return;
  }
  openDialog((close) => <ConflictsDialog onClose={close} />);
}

export function openMergeEditor(path: string) {
  void editorService().openInput(mergeInput(stripSlash(path)), { focus: true });
}

async function acceptSide(f: FileStatus, side: "ours" | "theirs") {
  const path = stripSlash(f.path);
  await runOp(
    side === "ours" ? tx`Accept yours for ${baseName(path)}` : tx`Accept theirs for ${baseName(path)}`,
    async () => {
      const v = await call(commands.vcsConflictVersions(path));
      const text = side === "ours" ? v.ours : v.theirs;
      if (text === null) {
        // The file was deleted on that side: resolving means removing it.
        await call(commands.fsDelete(path));
      } else {
        await writeFileText(path, text, { save: true });
      }
      await call(commands.vcsStage([path]));
    },
    { success: tx`${baseName(path)} resolved` },
  );
}

function ConflictsDialog({ onClose }: { onClose: () => void }) {
  const files = useVcs((s) => s.status).filter((f) => f.unstaged === "conflicted");
  const root = useVcs((s) => s.root) ?? "";
  const op = useVcs((s) => inProgress(s.branch?.operation));
  const head = useVcs((s) => s.branch?.head ?? null);
  const [active, setActive] = useState(0);
  const current = files[Math.min(active, files.length - 1)];
  // Once everything is resolved the dialog concludes the stopped operation, as IDEA does.
  const conclude =
    op && !files.length
      ? op === "merge"
        ? { label: "Commit…", run: () => void executeAction("vcs.commit") }
        : { label: controlLabel(op, "continue"), run: () => void controlOperation("continue", op) }
      : null;
  return (
    <Dialog
      open
      title="Conflicts"
      onClose={onClose}
      width={600}
      footerStart={<span className={styles.hint}>{op ? operationTitle(op, head) : ""}</span>}
      buttons={[
        ...(conclude
          ? [
              {
                label: conclude.label,
                role: "default" as const,
                autoFocus: true,
                onClick: () => {
                  onClose();
                  conclude.run();
                },
              },
            ]
          : []),
        { label: "Accept Yours", disabled: !current, onClick: () => current && void acceptSide(current, "ours") },
        { label: "Accept Theirs", disabled: !current, onClick: () => current && void acceptSide(current, "theirs") },
        {
          label: "Merge…",
          role: conclude ? "extra" : "default",
          autoFocus: !conclude,
          disabled: !current,
          onClick: () => {
            if (!current) return;
            onClose();
            openMergeEditor(current.path);
          },
        },
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        {files.length
          ? files.length === 1
            ? tx`${files.length} file with conflicts`
            : tx`${files.length} files with conflicts`
          : tx("All conflicts resolved")}
      </div>
      <div style={{ height: 240, display: "flex", flexDirection: "column", padding: "0 14px 14px" }}>
        <List
          items={files}
          getKey={(f) => f.path}
          activeIndex={Math.min(active, files.length - 1)}
          onActiveChange={setActive}
          rowHeight={22}
          aria-label="Conflicted files"
          className={styles.boxList}
          empty={
            <span>
              <T>No conflicts</T>
            </span>
          }
          onActivate={(f, _i, e) => {
            if (e.type === "click" && (e as unknown as MouseEvent).detail < 2) return;
            onClose();
            openMergeEditor(f.path);
          }}
          renderItem={(f) => (
            <span className={styles.fileRow} style={{ flex: 1, padding: 0 }}>
              <Icon name={fileIconName(baseName(f.path))} size={14} />
              <span className={styles.fileName} style={{ color: "var(--vcs-conflict)" }}>
                {baseName(f.path)}
              </span>
              <span className={styles.fileDir}>{dirName(relTo(root, stripSlash(f.path)))}</span>
            </span>
          )}
        />
      </div>
    </Dialog>
  );
}

/** Resolves the conflict block at the caret of the active editor. */
export function resolveAtCaret(how: Resolution): boolean {
  const ed = activeEditor();
  if (!ed) return false;
  const { view } = ed;
  const blocks = parseConflicts(view.state.doc.toString());
  const block = blockAt(blocks, view.state.selection.main.head);
  if (!block) {
    notifications().notify({ group: "vcs", level: "info", title: "The caret is not inside a conflict" });
    return false;
  }
  view.dispatch({
    // During a rebase the user's commit is git's "theirs" section, as in the merge editor.
    changes: { from: block.from, to: block.to, insert: resolutionText(block, how, inProgress() === "rebase") },
    userEvent: "input.resolve",
    scrollIntoView: true,
  });
  return true;
}

/** Moves the caret to the next conflict marker in the active editor. */
export function gotoConflict(dir: 1 | -1): boolean {
  const ed = activeEditor();
  if (!ed) return false;
  const { view } = ed;
  const blocks = parseConflicts(view.state.doc.toString());
  if (!blocks.length) return false;
  const head = view.state.selection.main.head;
  const target =
    dir === 1
      ? (blocks.find((b) => b.from > head) ?? blocks[0]!)
      : ([...blocks].reverse().find((b) => b.to < head) ?? blocks[blocks.length - 1]!);
  view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  view.focus();
  return true;
}
