import { commitRepo } from "./multiRoot";
/** Create Patch… (from local changes or commits) and Apply Patch… (file or clipboard, with a preview). */
import { useEffect, useState } from "react";
import type { Commit, FileStatus, PatchFile, PatchSource } from "@/bindings";
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
import { tx } from "@/platform/i18n";

export type PatchOrigin = { kind: "changes"; files: FileStatus[] } | { kind: "commits"; commits: Commit[] };

/** File name IDEA suggests: the change list or commit subject, sanitised. */
export function suggestedPatchName(origin: PatchOrigin, listName: string): string {
  const base =
    origin.kind === "commits"
      ? origin.commits.length === 1
        ? origin.commits[0]!.summary
        : `${origin.commits.length} commits`
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

export function showCreatePatchForCommits(commits: Commit[]) {
  if (!commits.length) return;
  openDialog((close) => <CreatePatchDialog origin={{ kind: "commits", commits }} onClose={close} />);
}

async function browseSave(current: string): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save({ defaultPath: current, filters: [{ name: "Patch", extensions: ["patch", "diff"] }] })) ?? null;
  } catch {
    return null;
  }
}

/** Settings › Version Control › Confirmation › When patch is created: ask / no / show in Finder. */
async function afterPatchSaved(path: string) {
  const mode = workflowSettings().vcs.confirmation.onPatchCreated;
  if (mode === "no") return;
  if (mode === "ask") {
    const r = await ask({
      title: "Create Patch",
      body: tx("Patch file created successfully. Show it in Finder?"),
      checkbox: "Don't ask again",
      buttons: [{ id: "show", label: "Show", primary: true }],
    });
    const show = r.button === "show";
    if (r.checked) await rememberSetting("vcs.confirmation.onPatchCreated", show ? "reveal" : "no");
    if (!show) return;
  }
  void import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(path)).catch(() => undefined);
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
    const source: PatchSource =
      origin.kind === "changes"
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
      "Create patch",
      async () => {
        const patch = await call(commands.vcsCreatePatch(repo, source));
        if (toFile) await call(commands.vcsWritePatch(file.trim(), patch));
        else await navigator.clipboard.writeText(patch);
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
        <Checkbox checked={reverse} onChange={setReverse} label="Reverse patch" />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

/** Apply Patch…: from a file (chooser), or the clipboard. */
export async function showApplyPatch(from: "file" | "clipboard", path?: string) {
  let text: string | null;
  let source = "Clipboard";
  try {
    if (from === "clipboard") {
      text = await navigator.clipboard.readText();
    } else {
      let file = path ?? null;
      if (!file) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({
          multiple: false,
          directory: false,
          defaultPath: useVcs.getState().root ?? undefined,
          filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
        });
        file = typeof picked === "string" ? picked : null;
      }
      if (!file) return;
      source = baseName(file);
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
  openDialog((close) => <ApplyPatchDialog patch={patch} source={source} onClose={close} />);
}

function ApplyPatchDialog({ patch, source, onClose }: { patch: string; source: string; onClose: () => void }) {
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
  }, [patch]);
  const failing = files?.filter((f) => !f.applies).length ?? 0;
  const run = async () => {
    onClose();
    await saveAll();
    const outcome = await runOp(`Apply patch (${source})`, () => call(commands.vcsApplyPatch(repo, patch)), {
      refresh: false,
    });
    if (outcome) await reportApply(outcome, "Patch applied");
  };
  return (
    <Dialog
      open
      title={tx`Apply Patch: ${source}`}
      onClose={onClose}
      width={600}
      footerStart={
        files && failing > 0 ? (
          <span className={styles.hint}>
            {failing === 1
              ? tx`${failing} file will be merged; conflicts open in the merge tool`
              : tx`${failing} files will be merged; conflicts open in the merge tool`}
          </span>
        ) : undefined
      }
      buttons={[
        { label: "OK", role: "default", autoFocus: true, disabled: !files?.length, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        {files ? `${files.length} file${files.length === 1 ? "" : "s"} in the patch` : ""}
      </div>
      <div style={{ height: 280, display: "flex", flexDirection: "column", padding: "0 14px 14px" }}>
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : !files ? (
          <div className={styles.empty}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={files}
            getKey={(f) => f.path}
            rowHeight={22}
            aria-label="Patch files"
            className={styles.boxList}
            empty={
              <span>
                <T>No changes</T>
              </span>
            }
            renderItem={(f) => (
              <span
                className={styles.fileRow}
                style={{ flex: 1, padding: 0 }}
                title={
                  f.applies ? tx("Applies cleanly") : tx("Does not apply cleanly: a 3-way merge will be attempted")
                }
              >
                <Icon name={fileIconName(baseName(f.path))} size={14} />
                <span
                  className={styles.fileName}
                  style={{
                    color:
                      KIND_COLOR[f.kind === "untracked" ? "added" : f.kind === "conflicted" ? "conflicted" : f.kind],
                  }}
                >
                  {baseName(f.path)}
                </span>
                <span className={styles.fileDir}>{f.oldPath ? tx`from ${f.oldPath}` : dirName(f.path)}</span>
                <span className={styles.grow} />
                <span className={styles.commitMeta}>{f.binary ? tx("binary") : `+${f.added} −${f.removed}`}</span>
                {!f.applies && <Icon name="warning" size={14} label="Does not apply cleanly" />}
              </span>
            )}
          />
        )}
      </div>
    </Dialog>
  );
}
