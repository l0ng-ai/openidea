import { readClipboardPlainText, writeClipboardText } from "@/platform/clipboard";
import { commitRepo } from "./multiRoot";
/** Create Patch… (from local changes or commits) and Apply Patch… (file or clipboard, with a preview). */
import { useEffect, useState } from "react";
import type { Commit, FileStatus, PatchFile, PatchSource, ShelvedChangeList } from "@/bindings";
import { canRevealInFileManager, fileManagerName, revealInFileManager } from "@/platform/fileManager";
import { call, commands } from "@/platform/ipc";
import { Button, Checkbox, Dialog, Icon, Input, List, Spinner, fileIconName, T } from "@/ui";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { rememberSetting } from "./confirmations";
import { openDialog } from "./dialogs";
import { KIND_COLOR, baseName, dirName, stripSlash } from "./model";
import { errorMessage, logConsole, runOp, saveAll } from "./ops";
import { FileChecklist, defaultChangeFiles, reportApply } from "./shelf";
import { activeList, useChangelists } from "./changelists";
import { currentRepoRoot, useVcs } from "./store";
import styles from "./common.module.css";
import { tx, useTx } from "@/platform/i18n";
import previewStyles from "./ApplyPatch.module.css";

export type PatchOrigin =
  | { kind: "changes"; files: FileStatus[] }
  | { kind: "commits"; commits: Commit[] }
  | { kind: "shelf"; entry: ShelvedChangeList; path?: string };

/** File name IDEA suggests: the change list or commit subject, sanitised. */
export function suggestedPatchName(origin: PatchOrigin, listName: string): string {
  const base =
    origin.kind === "commits"
      ? origin.commits.length === 1
        ? origin.commits[0]!.summary
        : `${origin.commits.length} commits`
      : origin.kind === "shelf"
        ? origin.entry.name
        : listName;
  const clean = base
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${clean || "changes"}.patch`;
}

export function showCreatePatchForChanges(paths?: readonly string[]) {
  const files = defaultChangeFiles(paths);
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: "No changes to create a patch from" });
    return;
  }
  openDialog((close) => <CreatePatchDialog origin={{ kind: "changes", files }} onClose={close} />);
}

/** Copy as Patch to Clipboard: the selected local changes, without a dialog. */
export async function copyChangesAsPatch(paths: readonly string[]) {
  const files = defaultChangeFiles(paths);
  if (!files.length) return;
  await saveAll();
  await runOp(
    tx("Create patch"),
    async () => {
      const source: PatchSource = { from: "changes", paths: files.map((f) => stripSlash(f.path)), reverse: false };
      await writeClipboardText(await call(commands.vcsCreatePatch(currentRepoRoot(), source)));
    },
    { success: "Patch copied to the clipboard", refresh: false },
  );
}

export function showCreatePatchForCommits(commits: Commit[]) {
  if (!commits.length) return;
  openDialog((close) => <CreatePatchDialog origin={{ kind: "commits", commits }} onClose={close} />);
}

export function showCreatePatchForShelf(entry: ShelvedChangeList, path?: string) {
  openDialog((close) => <CreatePatchDialog origin={{ kind: "shelf", entry, path }} onClose={close} />);
}

async function browseSave(current: string): Promise<string | null> {
  try {
    const { save } = await import("@/platform/dialog");
    return (await save({ defaultPath: current, filters: [{ name: "Patch", extensions: ["patch", "diff"] }] })) ?? null;
  } catch {
    return null;
  }
}

/** Whole sentences let each locale translate the patch question. */
export function patchSavedBody(): string {
  const name = fileManagerName();
  return name === "Finder"
    ? "Patch file created successfully. Show it in Finder?"
    : name === "Explorer"
      ? "Patch file created successfully. Show it in Explorer?"
      : "Patch file created successfully. Show it in Files?";
}

/** Settings › Version Control › Confirmation › When patch is created: ask / no / show in the file manager. */
async function afterPatchSaved(path: string) {
  const mode = workflowSettings().vcs.confirmation.onPatchCreated;
  if (mode === "no" || !canRevealInFileManager()) return;
  if (mode === "ask") {
    const r = await ask({
      title: "Create Patch",
      body: tx(patchSavedBody()),
      checkbox: "Don't ask again",
      buttons: [{ id: "show", label: "Show", primary: true }],
    });
    const show = r.button === "show";
    if (r.checked) await rememberSetting("vcs.confirmation.onPatchCreated", show ? "reveal" : "no");
    if (!show) return;
  }
  void revealInFileManager(path).catch(() => undefined);
}

function CreatePatchDialog({ origin, onClose }: { origin: PatchOrigin; onClose: () => void }) {
  const root = useVcs((s) => s.root) ?? "";
  const [repo] = useState(() =>
    origin.kind === "commits" ? (commitRepo(origin.commits[0]!) ?? currentRepoRoot()) : currentRepoRoot(),
  );
  const listName = useChangelists((s) => activeList(s.state).name);
  const [selected, setSelected] = useState(
    () => new Set(origin.kind === "changes" ? origin.files.map((f) => f.path) : []),
  );
  const [toFile, setToFile] = useState(true);
  const [file, setFile] = useState(() => `${root}/${suggestedPatchName(origin, listName)}`);
  const [reverse, setReverse] = useState(false);
  const empty = origin.kind === "changes" && !selected.size;
  const run = async () => {
    if (empty || (toFile && !file.trim())) return;
    onClose();
    await saveAll();
    const source: PatchSource | null =
      origin.kind === "shelf"
        ? null
        : origin.kind === "changes"
          ? {
              from: "changes",
              paths: origin.files.filter((f) => selected.has(f.path)).map((f) => stripSlash(f.path)),
              reverse,
            }
          : {
              from: "commits",
              commits: [...origin.commits].sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0)).map((c) => c.id),
              reverse,
            };
    const done = await runOp(
      tx("Create patch"),
      async () => {
        const patch =
          origin.kind === "shelf"
            ? await call(commands.vcsShelfPatch(origin.entry.id, origin.path ?? null))
            : await call(commands.vcsCreatePatch(repo, source!));
        if (toFile) await call(commands.vcsWritePatch(file.trim(), patch));
        else await writeClipboardText(patch);
        return true;
      },
      { success: toFile ? `Patch saved to ${baseName(file.trim())}` : "Patch copied to the clipboard", refresh: false },
    );
    if (done && toFile) await afterPatchSaved(file.trim());
  };
  return (
    <Dialog
      open
      title="Create Patch"
      onClose={onClose}
      width={560}
      buttons={[
        { label: "Create", role: "default", disabled: empty || (toFile && !file.trim()), onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      {origin.kind === "changes" ? (
        <>
          <div className={styles.section}>
            <T>Changes to include:</T>
          </div>
          <FileChecklist files={origin.files} selected={selected} onChange={setSelected} label="Files to include" />
        </>
      ) : origin.kind === "shelf" ? (
        <div className={styles.section}>{origin.path ?? origin.entry.name}</div>
      ) : (
        <div className={styles.section}>
          {origin.commits.length === 1
            ? `${origin.commits[0]!.shortId} ${origin.commits[0]!.summary}`
            : `${origin.commits.length} commits`}
        </div>
      )}
      <div className={styles.form} role="radiogroup" aria-label={tx("Patch destination")}>
        <label className={styles.radioRow}>
          <input type="radio" name="dest" checked={toFile} onChange={() => setToFile(true)} />
          <span className={styles.radioText}>
            <T>Save to file:</T>
          </span>
        </label>
        <div className={styles.cloneDirRow}>
          <Input
            className={styles.cloneDirInput}
            mono
            aria-label="Patch file"
            disabled={!toFile}
            value={file}
            onChange={(e) => setFile(e.target.value)}
          />
          <Button disabled={!toFile} onClick={() => void browseSave(file).then((p) => p && setFile(p))}>
            <T>Browse…</T>
          </Button>
        </div>
        <label className={styles.radioRow}>
          <input type="radio" name="dest" checked={!toFile} onChange={() => setToFile(false)} />
          <span className={styles.radioText}>
            <T>Copy to clipboard</T>
          </span>
        </label>
        {origin.kind !== "shelf" && <Checkbox checked={reverse} onChange={setReverse} label="Reverse patch" />}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

/** Apply Patch…: from a file (chooser), or the clipboard. */
export async function showApplyPatch(from: "file" | "clipboard", path?: string) {
  let text: string | null;
  let sourcePath: string | null = null;
  try {
    if (from === "clipboard") {
      text = await readClipboardPlainText();
    } else {
      let file = path ?? null;
      if (!file) {
        const { open } = await import("@/platform/dialog");
        const picked = await open({
          multiple: false,
          directory: false,
          defaultPath: useVcs.getState().root ?? undefined,
          filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
        });
        file = typeof picked === "string" ? picked : null;
      }
      if (!file) return;
      sourcePath = file;
      text = await call(commands.fsReadText(file));
    }
  } catch (e) {
    logConsole("err", errorMessage(e));
    notifications().notify({ group: "vcs", level: "error", title: "Cannot read the patch", body: errorMessage(e) });
    return;
  }
  if (!text?.trim()) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: from === "clipboard" ? "The clipboard does not contain a patch" : "The patch file is empty",
    });
    return;
  }
  const patch = text;
  openDialog((close) => <ApplyPatchDialog patch={patch} sourcePath={sourcePath} onClose={close} />);
}

function PatchFileRow({ file }: { file: PatchFile }) {
  const t = useTx();
  const name = baseName(file.path);
  return (
    <span
      className={styles.fileTreeRow}
      title={file.applies ? t("Applies cleanly") : t("Does not apply cleanly: a 3-way merge will be attempted")}
    >
      <Icon name={fileIconName(name, file.path)} size={14} />
      <span className={previewStyles.filePath}>
        <span
          className={previewStyles.fileName}
          style={{ color: KIND_COLOR[file.kind === "untracked" ? "added" : file.kind] }}
          title={file.path}
        >
          {name}
        </span>
        <span className={styles.fileDir}>{file.oldPath ? t`from ${file.oldPath}` : dirName(file.path)}</span>
      </span>
      <span className={previewStyles.stats}>{file.binary ? t("binary") : `+${file.added} −${file.removed}`}</span>
      <span className={previewStyles.fileStatus}>
        {!file.applies && <Icon name="warning" size={14} label="Does not apply cleanly" />}
      </span>
    </span>
  );
}

function ApplyPatchDialog({
  patch,
  sourcePath,
  onClose,
}: {
  patch: string;
  sourcePath: string | null;
  onClose: () => void;
}) {
  const t = useTx();
  const source = sourcePath ? baseName(sourcePath) : t("Clipboard");
  const [repo] = useState(currentRepoRoot);
  const [files, setFiles] = useState<PatchFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void saveAll().then(() =>
      call(commands.vcsPatchPreview(repo, patch))
        .then((f) => alive && setFiles(f))
        .catch((e) => alive && setError(errorMessage(e))),
    );
    return () => {
      alive = false;
    };
  }, [patch, repo]);
  const count = files?.length ?? 0;
  const failing = files?.filter((f) => !f.applies).length ?? 0;
  const run = async () => {
    onClose();
    await saveAll();
    const outcome = await runOp(t`Apply patch (${source})`, () => call(commands.vcsApplyPatch(repo, patch)), {
      refresh: false,
    });
    if (outcome) await reportApply(outcome, "Patch applied");
  };
  return (
    <Dialog
      open
      title="Apply Patch"
      aria-label={t`Apply Patch: ${source}`}
      onClose={onClose}
      width={660}
      resizable="both"
      minWidth={320}
      className={previewStyles.dialog}
      buttons={[
        { label: "Apply", role: "default", autoFocus: true, disabled: !count, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={previewStyles.preview}>
        <div className={previewStyles.fields}>
          <label className={previewStyles.field}>
            <T>Patch source</T>
            <Input readOnly value={sourcePath ?? source} title={sourcePath ?? undefined} />
          </label>
          {repo && (
            <label className={previewStyles.field}>
              <T>Repository</T>
              <Input readOnly value={repo} title={repo} />
            </label>
          )}
        </div>
        <section className={previewStyles.files}>
          <div className={previewStyles.filesHeader}>
            <h2 className={previewStyles.heading}>
              <T>Patch files</T>
            </h2>
            {files && <span className={previewStyles.stats}>{count === 1 ? t`${count} file` : t`${count} files`}</span>}
          </div>
          {error ? (
            <div className={previewStyles.error} role="alert">
              {error}
            </div>
          ) : !files ? (
            <div className={styles.empty}>
              <Spinner size={14} />
            </div>
          ) : (
            <List
              items={files}
              getKey={(f) => f.path}
              aria-label="Patch files"
              className={previewStyles.list}
              empty={<T>No changes</T>}
              renderItem={(file) => <PatchFileRow file={file} />}
            />
          )}
          {failing > 0 && (
            <div className={previewStyles.warning} role="status">
              <Icon name="warning" size={14} />
              <span>
                {failing === 1
                  ? t`${failing} file will be merged; conflicts open in the merge tool`
                  : t`${failing} files will be merged; conflicts open in the merge tool`}
              </span>
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
