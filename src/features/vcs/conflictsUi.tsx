/** "Resolve Conflicts" dialog and in-editor conflict resolution actions. */
import { useEffect, useRef, useState } from "react";
import type { FileStatus } from "@/bindings";
import { activeEditor } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { Button, Dialog, Icon, List, fileIconName, T } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { blockAt, parseConflicts, resolutionText, type Resolution } from "./conflicts";
import { openDialog } from "./dialogs";
import { mergeInput } from "./mergeKind";
import { baseName, dirName, relTo, stripSlash } from "./model";
import { controlLabel, controlOperation, inProgress, operationTitle, type InProgress } from "./operations";
import { runOp, writeFileText } from "./ops";
import { executeAction } from "@/platform/actions";
import { conflictedFiles, useVcs } from "./store";
import styles from "./ConflictsDialog.module.css";
import { tx } from "@/platform/i18n";

/**
 * The stopped rebase / cherry-pick / revert whose conflicts are being resolved from the
 * Conflicts dialog (there or in the merge editor it opened): once the last one is
 * resolved the operation continues by itself, as IDEA does. Closing the dialog
 * without resolving them leaves it stopped.
 */
let continueWhenResolved: InProgress | null = null;

/** The operation to continue now that its conflicts are resolved, if any (only once). */
export function takeContinueWhenResolved(): InProgress | null {
  const op = continueWhenResolved;
  continueWhenResolved = null;
  return op;
}

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

/** Accept Yours / Accept Theirs for a whole conflicted file. */
export async function acceptSide(f: FileStatus, side: "ours" | "theirs") {
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
  useEffect(() => {
    continueWhenResolved = op && op !== "merge" ? op : null;
  }, [op]);
  // The last conflict resolved here: the operation continues (see onConflictsCleared), the dialog goes.
  const hadConflicts = useRef(files.length > 0);
  useEffect(() => {
    if (hadConflicts.current && !files.length && op && op !== "merge") onClose();
    hadConflicts.current = files.length > 0;
  }, [files.length, op, onClose]);
  // Closed without going on to resolve them: the operation stays stopped.
  const dismiss = () => {
    continueWhenResolved = null;
    onClose();
  };
  const head = useVcs((s) => s.branch?.head ?? null);
  const [active, setActive] = useState(0);
  const current = files[Math.min(active, files.length - 1)];
  const edit = (file: FileStatus) => {
    onClose();
    openMergeEditor(file.path);
  };
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
      onClose={dismiss}
      className={styles.dialog}
      width={680}
      resizable="both"
      minWidth={360}
      minHeight={320}
      buttons={[
        ...(conclude
          ? [
              {
                label: conclude.label,
                role: "default" as const,
                autoFocus: true,
                onClick: () => {
                  dismiss();
                  conclude.run();
                },
              },
            ]
          : []),
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={styles.content}>
        <div className={styles.summary}>
          {op && <span>{operationTitle(op, head)}</span>}
          <span className={styles.count} role="status">
            {files.length
              ? files.length === 1
                ? tx`${files.length} file with conflicts`
                : tx`${files.length} files with conflicts`
              : tx("All conflicts resolved")}
          </span>
        </div>
        <div className={styles.workspace}>
          <div className={styles.listFrame}>
            <div className={styles.listHeader} aria-hidden>
              <T>Name</T>
            </div>
            <List
              autoFocus={!!current}
              items={files}
              getKey={(f) => f.path}
              activeIndex={Math.min(active, files.length - 1)}
              onActiveChange={setActive}
              aria-label={tx("Conflicted files")}
              className={styles.list}
              empty={<T>No conflicts</T>}
              onActivate={(f, _i, e) => {
                if (e.type === "click" && (e as unknown as MouseEvent).detail < 2) return;
                edit(f);
              }}
              renderItem={(f) => {
                const path = relTo(root, stripSlash(f.path));
                const name = baseName(f.path);
                const dir = dirName(path);
                return (
                  <span className={styles.row} title={path}>
                    <Icon name={fileIconName(name, f.path)} size={16} />
                    <span className={styles.fileName}>{name}</span>
                    {dir && <span className={styles.fileDir}>{dir}</span>}
                  </span>
                );
              }}
            />
          </div>
          <div className={styles.actions} role="group" aria-label={tx("Conflict resolution")}>
            <Button disabled={!current} onClick={() => current && void acceptSide(current, "ours")}>
              Accept Yours
            </Button>
            <Button disabled={!current} onClick={() => current && void acceptSide(current, "theirs")}>
              Accept Theirs
            </Button>
            <Button
              variant={conclude ? "secondary" : "primary"}
              disabled={!current}
              onClick={() => current && edit(current)}
            >
              Merge…
            </Button>
          </div>
        </div>
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
