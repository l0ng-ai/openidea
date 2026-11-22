import { readClipboardPlainText, writeClipboardText } from "@/platform/clipboard";
import { commitRepo } from "./multiRoot";
/** Create Patch… (from local changes or commits) and Apply Patch… (file or clipboard, with a preview). */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  Commit,
  FileStatus,
  PatchFile,
  PatchPathMapping,
  PatchPlacement,
  PatchPreview,
  PatchSource,
  ShelvedChangeList,
  StagingPatchEntry,
} from "@/bindings";
import { canRevealInFileManager, fileManagerName, revealInFileManager } from "@/platform/fileManager";
import { ENCODING_CHOICES, editorPrefs } from "@/platform/editorSettings";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { ipcPath, isSameOrInside } from "@/platform/paths";
import { useProject } from "@/platform/project";
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  Select,
  Spinner,
  Tree,
  fileIconName,
  T,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import { executeAction } from "@/platform/actions";
import { bindingsFor, normalizeBinding, registerKeyClaim, shortcutLabel } from "@/platform/keymap";
import { choosePath } from "@/platform/choosePath";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { rememberSetting } from "./confirmations";
import { displayPath } from "./compareData";
import { openDialog } from "./dialogs";
import { KIND_COLOR, baseName, dirName, stripSlash } from "./model";
import { errorMessage, logConsole, runOp, saveAll } from "./ops";
import { FileChecklist, defaultChangeFiles, reportApply } from "./shelf";
import {
  activeList,
  addList,
  flushChangelists,
  moveFiles,
  relOf,
  updateChangelists,
  useChangelists,
} from "./changelists";
import { ChangelistNamePicker } from "./changelistsUi";
import { groupOf, renamedFromPath } from "./changes";
import { repositoryPath } from "./repositoryPaths";
import { useStagingArea } from "./staging";
import { currentRepoRoot, refreshNow, repoOf, statusOf, useVcs } from "./store";
import styles from "./common.module.css";
import { tx, useTx } from "@/platform/i18n";
import previewStyles from "./ApplyPatch.module.css";
import type { PatchDiffRequest } from "./patchDiff";

export type PatchOrigin =
  | { kind: "changes"; files: FileStatus[]; staging?: readonly StagingPatchEntry[] }
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

export type PatchSelection = readonly string[] | { staging: readonly StagingPatchEntry[] };

function patchChanges(selection?: PatchSelection): Extract<PatchOrigin, { kind: "changes" }> {
  if (selection && "staging" in selection) {
    const files = selection.staging.flatMap(({ path }) => {
      const file = statusOf(path);
      return file ? [file] : [];
    });
    return { kind: "changes", files, staging: selection.staging };
  }
  return { kind: "changes", files: defaultChangeFiles(selection) };
}

function localPatchSource(
  origin: Extract<PatchOrigin, { kind: "changes" }>,
  selected: ReadonlySet<string>,
  reverse: boolean,
): PatchSource {
  const files = origin.files.filter((f) => selected.has(f.path));
  if (origin.staging) {
    const paths = new Set(files.map((f) => stripSlash(f.path)));
    return { from: "staging", entries: origin.staging.filter((entry) => paths.has(entry.path)), reverse };
  }
  const paths = files.flatMap((file) => {
    const path = stripSlash(file.path);
    const before = renamedFromPath(file);
    return before ? [path, before] : [path];
  });
  return { from: "changes", paths: [...new Set(paths)], reverse };
}

function noPatchChanges() {
  notifications().notify({ group: "vcs", level: "info", title: "No changes to create a patch from" });
}

export function showCreatePatchForChanges(selection?: PatchSelection) {
  const origin = patchChanges(selection);
  if (!origin.files.length) {
    noPatchChanges();
    return;
  }
  openDialog((close) => <CreatePatchDialog origin={origin} onClose={close} />);
}

/** Copy as Patch to Clipboard: the selected local changes, without a dialog. */
export async function copyChangesAsPatch(selection?: PatchSelection) {
  const origin = patchChanges(selection);
  if (!origin.files.length) {
    noPatchChanges();
    return;
  }
  await saveAll();
  await runOp(
    tx("Create patch"),
    async () => {
      const source = localPatchSource(origin, new Set(origin.files.map((file) => file.path)), false);
      const patch = await call(commands.vcsCreatePatch(origin.staging ? null : currentRepoRoot(), source, null));
      if (!patch) {
        noPatchChanges();
        return false;
      }
      await writeClipboardText(patch);
      return true;
    },
    { success: (copied) => (copied ? "Patch copied to the clipboard" : ""), refresh: false },
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

function commonPatchBase(roots: readonly string[], project: string): string {
  if (roots.length === 1) return roots[0]!;
  for (let dir = project; dir;) {
    if (roots.every((root) => isSameOrInside(root, dir))) return dir;
    if (/^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+)?\/$/.test(dir) || /^\/\/[^/]+\/[^/]+$/.test(dir)) break;
    const parent = dirName(dir);
    dir = /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent || "/";
  }
  return project;
}

const PATCH_ENCODINGS = ENCODING_CHOICES.map(([value, label]) => ({ value, label, verbatim: true }));

function CreatePatchDialog({ origin, onClose }: { origin: PatchOrigin; onClose: () => void }) {
  const t = useTx();
  const baseId = useId();
  const encodingId = useId();
  const root = useVcs((s) => s.root) ?? "";
  const roots = useVcs((s) => s.roots);
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
  const [baseInput, setBaseInput] = useState<string | null>(null);
  const [encoding, setEncoding] = useState(() => {
    const { project, global } = editorPrefs().encodings;
    const preferred = (project || global).toLowerCase();
    return PATCH_ENCODINGS.some(({ value }) => value === preferred) ? preferred : "utf-8";
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const selectedRoots =
    origin.kind === "changes"
      ? [...new Set(origin.files.filter((f) => selected.has(f.path)).flatMap((f) => repoOf(f.path, roots) ?? []))]
      : [];
  const defaultBase =
    origin.kind === "shelf"
      ? (origin.entry.repo ?? repo ?? root)
      : selectedRoots.length
        ? commonPatchBase(selectedRoots, root)
        : (repo ?? root);
  const base = baseInput ?? defaultBase;
  const disabled = pending || (origin.kind === "changes" && !selected.size) || !base.trim() || (toFile && !file.trim());
  const run = async () => {
    if (disabled) return;
    setPending(true);
    setError("");
    const source: PatchSource | null =
      origin.kind === "shelf"
        ? null
        : origin.kind === "changes"
          ? localPatchSource(origin, selected, reverse)
          : {
              from: "commits",
              commits: [...origin.commits].sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0)).map((c) => c.id),
              reverse,
            };
    const done = await runOp(
      t("Create patch"),
      async () => {
        await saveAll();
        const directory = ipcPath(base.trim());
        const patch =
          origin.kind === "shelf"
            ? await call(
                commands.vcsShelfPatch(origin.entry.id, origin.path ?? null, baseInput === null ? null : directory),
              )
            : await call(commands.vcsCreatePatch(origin.kind === "commits" ? repo : null, source!, directory));
        if (!patch) {
          noPatchChanges();
          return false;
        }
        if (toFile) await call(commands.vcsWritePatch(ipcPath(file.trim()), patch, encoding));
        else await writeClipboardText(patch);
        return true;
      },
      {
        success: (created) =>
          created ? (toFile ? `Patch saved to ${baseName(file.trim())}` : "Patch copied to the clipboard") : "",
        onError: (message) => {
          setError(message);
          return true;
        },
        refresh: false,
      },
    );
    setPending(false);
    if (!done) return;
    onClose();
    if (toFile) await afterPatchSaved(ipcPath(file.trim()));
  };
  return (
    <Dialog
      open
      title="Create Patch"
      onClose={() => {
        if (!pending) onClose();
      }}
      width={560}
      buttons={[
        { label: "Create", role: "default", disabled, onClick: () => void run() },
        { label: "Cancel", role: "cancel", disabled: pending },
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
      <div className={styles.form}>
        <div className={styles.fieldLabel}>
          <label htmlFor={baseId}>
            <T>Base directory</T>
          </label>
        </div>
        <div className={styles.cloneDirRow}>
          <Input
            id={baseId}
            className={styles.cloneDirInput}
            mono
            value={base}
            onChange={(e) => setBaseInput(e.target.value)}
          />
          <Button
            aria-label={t("Browse for base directory")}
            onClick={() =>
              void choosePath({ directory: true, title: t("Choose Base Directory"), defaultPath: base.trim() }).then(
                (path) => {
                  if (path) setBaseInput(ipcPath(path));
                },
              )
            }
          >
            <T>Browse…</T>
          </Button>
        </div>
        <div className={styles.patchDestination} role="radiogroup" aria-label={t("Patch destination")}>
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
        </div>
        <label className={styles.fieldLabel} htmlFor={encodingId}>
          <T>Patch encoding</T>
        </label>
        <Select
          id={encodingId}
          aria-label={t("Patch encoding")}
          value={encoding}
          options={PATCH_ENCODINGS}
          onChange={setEncoding}
          disabled={!toFile}
        />
        {origin.kind !== "shelf" && <Checkbox checked={reverse} onChange={setReverse} label="Reverse patch" />}
        {error && (
          <div className={styles.error} role="alert">
            {t(error)}
          </div>
        )}
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
      text = await call(commands.vcsReadPatch(file));
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

function groupPatchFiles(files: PatchFile[]): PatchFile[] {
  const grouped = new Map<string, PatchFile>();
  for (const file of files) {
    const previous = grouped.get(file.path);
    grouped.set(
      file.path,
      previous
        ? {
            ...previous,
            added: previous.added + file.added,
            removed: previous.removed + file.removed,
            binary: previous.binary || file.binary,
            applies: previous.applies && file.applies,
            missingBase: previous.missingBase || file.missingBase,
          }
        : file,
    );
  }
  return [...grouped.values()];
}

function PatchFileRow({
  file,
  placement,
  projectRoot,
  hasDirectoryMatches,
  checked,
  onChange,
  onChooseBase,
}: {
  file: PatchFile;
  placement?: PatchPlacement;
  projectRoot: string | null;
  hasDirectoryMatches: boolean;
  checked: boolean;
  onChange: () => void;
  onChooseBase: (owner: HTMLElement) => void;
}) {
  const t = useTx();
  const { path } = file;
  const shownPath = placement?.target ?? path;
  const name = baseName(shownPath);
  return (
    <span
      className={styles.fileTreeRow}
      title={
        placement?.error
          ? t(placement.error)
          : file.missingBase
            ? t("Missing base file")
            : file.applies
              ? t("Applies cleanly")
              : t("Does not apply cleanly: a 3-way merge will be attempted")
      }
    >
      <Checkbox
        tabIndex={-1}
        aria-label={t`Include ${path}`}
        checked={checked}
        disabled={!!placement?.error || file.missingBase}
        onChange={onChange}
      />
      <Icon name={fileIconName(name, shownPath)} size={14} />
      <span className={previewStyles.filePath}>
        <span
          className={previewStyles.fileName}
          style={{ color: KIND_COLOR[file.kind === "untracked" ? "added" : file.kind] }}
          title={file.path}
        >
          {name}
        </span>
        <span className={styles.fileDir} title={placement?.target ?? undefined}>
          {placement?.error
            ? t(placement.error)
            : placement?.target
              ? displayPath(dirName(placement.target), projectRoot)
              : file.oldPath
                ? t`from ${file.oldPath}`
                : dirName(file.path)}
        </span>
      </span>
      {(file.missingBase || (placement?.error && hasDirectoryMatches)) && (
        <button
          type="button"
          className={previewStyles.chooseBase}
          onClick={(event) => {
            event.stopPropagation();
            onChooseBase(event.currentTarget);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <T>{hasDirectoryMatches ? "Choose matching directory…" : "Select missing base…"}</T>
        </button>
      )}
      <span className={previewStyles.stats}>{file.binary ? t("binary") : `+${file.added} −${file.removed}`}</span>
      <span className={previewStyles.fileStatus}>
        {file.missingBase ? (
          <Icon name="warning" size={14} label="Missing base file" />
        ) : !file.applies ? (
          <Icon name="warning" size={14} label="Does not apply cleanly" />
        ) : null}
      </span>
    </span>
  );
}

const PROJECT_PATCH_TARGET = "project";
const NO_PATCH_MAPPINGS: PatchPathMapping[] = [];

type PatchChangelist = { id: string } | { name: string };

async function assignPatchChangelist(
  paths: readonly string[],
  target: PatchChangelist,
  projectRoot: string | undefined,
) {
  const current = () => useProject.getState().project?.root === projectRoot && useChangelists.getState().loaded;
  if (!current()) return;
  const applied = new Set(paths.map(stripSlash));
  const statuses = () => useVcs.getState().status.filter((file) => applied.has(stripSlash(file.path)));
  // A new file must be under version control to appear in a changelist. Leave its content unstaged.
  const newFiles = statuses()
    .filter((file) => groupOf(file) === "unversioned")
    .map((file) => stripSlash(file.path));
  if (newFiles.length) {
    await runOp(tx("Stage Without Content"), () => call(commands.vcsStageWithoutContent(newFiles)), { refresh: false });
    await refreshNow();
  }
  if (!current()) return;
  const rels = statuses()
    .filter((file) => groupOf(file) === "changes" || groupOf(file) === "conflicts")
    .map((file) => relOf(file.path));
  if (!rels.length) return;
  updateChangelists((state) => {
    if ("id" in target) return moveFiles(state, rels, target.id);
    const existing = state.lists.find((list) => list.name.toLowerCase() === target.name.toLowerCase());
    if (existing) return moveFiles(state, rels, existing.id);
    const created = addList(state, target.name);
    return moveFiles(created.state, rels, created.id);
  });
  await flushChangelists();
}

function maxPatchStrip(file: PatchFile): number {
  const depth = (path: string) => path.split("/").filter(Boolean).length - 1;
  return Math.max(0, Math.min(depth(file.path), depth(file.oldPath ?? file.path)));
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
  const [initialRepo] = useState(currentRepoRoot);
  const root = useVcs((s) => s.root);
  const roots = useVcs((s) => s.roots);
  const staging = useStagingArea();
  const lists = useChangelists((s) => s.state);
  const listsLoaded = useChangelists((s) => s.loaded);
  const [listName, setListName] = useState<string | null>(null);
  const chosenName = listName ?? activeList(lists).name;
  const existingList = lists.lists.find((list) => list.name.toLowerCase() === chosenName.trim().toLowerCase());
  const validList = staging || (listsLoaded && !!chosenName.trim());
  const [choice, setChoice] = useState<string | null>(null);
  const repo = choice && choice !== PROJECT_PATCH_TARGET ? choice : initialRepo;
  const target = choice === PROJECT_PATCH_TARGET ? "project" : choice === null ? null : "repository";
  const [preview, setPreview] = useState<PatchPreview | null>(null);
  const [mappingByPath, setMappingByPath] = useState<ReadonlyMap<string, PatchPathMapping>>(() => new Map());
  const mappings = useMemo(() => (mappingByPath.size ? [...mappingByPath.values()] : null), [mappingByPath]);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [indexReady, setIndexReady] = useState(false);
  useEffect(
    () =>
      onIdeEvent("indexState", ({ indexing }) => {
        if (!indexing) setIndexReady(true);
      }),
    [],
  );
  useEffect(() => {
    let alive = true;
    const load = async () => {
      await saveAll();
      if (!alive) return;
      const result = await call(commands.vcsPatchPreview(repo, patch, target, mappings));
      if (alive) setPreview({ ...result, files: groupPatchFiles(result.files) });
    };
    void load().catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [indexReady, mappings, patch, repo, target]);
  const files = preview?.files;
  const base = preview?.base;
  const automatic = preview?.automaticMappings ?? NO_PATCH_MAPPINGS;
  const mapped = useMemo(
    () => (preview?.placements ? [...(mappings ?? NO_PATCH_MAPPINGS), ...automatic] : null),
    [automatic, mappings, preview?.placements],
  );
  const effectiveMappings = useMemo(() => new Map(mapped?.map((mapping) => [mapping.path, mapping])), [mapped]);
  const directoryMatches = useMemo(
    () => new Map(preview?.directoryMatches?.map(({ path, candidates }) => [path, candidates])),
    [preview],
  );
  const placements = useMemo(() => {
    const result = new Map<string, PatchPlacement>();
    for (const placement of preview?.placements ?? []) {
      if (!result.get(placement.path)?.error) result.set(placement.path, placement);
    }
    return result;
  }, [preview]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(() => new Set());
  const fileList = useRef<HTMLElement>(null);
  const activeFile = files?.find((file) => file.path === activePath) ?? files?.[0];
  const showDiff = useCallback(
    (file: PatchFile) => {
      if (!files || file.missingBase || placements.get(file.path)?.error) return;
      void executeAction("vcs.patch.showDiff", {
        repo,
        base: base ?? null,
        patch,
        mappings: mapped,
        paths: files
          .filter((entry) => !entry.missingBase && !placements.get(entry.path)?.error)
          .map((entry) => entry.path),
        path: file.path,
      } satisfies PatchDiffRequest);
    },
    [base, files, mapped, patch, placements, repo],
  );
  useEffect(
    () =>
      registerKeyClaim((event, stroke) => {
        if (
          !activeFile ||
          !(event.target instanceof Element) ||
          !fileList.current?.contains(event.target.closest('[role="tree"]')) ||
          !bindingsFor("vcs.showDiff").some((binding) => normalizeBinding(binding) === stroke)
        )
          return false;
        event.preventDefault();
        event.stopPropagation();
        showDiff(activeFile);
        return true;
      }),
    [activeFile, showDiff],
  );
  const count = files?.length ?? 0;
  const needsDirectory = (file: PatchFile) =>
    file.missingBase || (!!placements.get(file.path)?.error && directoryMatches.has(file.path));
  const available = files?.filter((f) => !f.missingBase && !placements.get(f.path)?.error) ?? [];
  const included = available.filter((f) => !excluded.has(f.path));
  const selected = included.length;
  const failing = included.filter((f) => !f.applies).length;
  const toggle = ({ path }: PatchFile) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };
  const updateMappings = (
    rows: readonly PatchFile[],
    update: (current: PatchPathMapping, file: PatchFile) => PatchPathMapping,
  ) => {
    setMappingByPath((previous) => {
      const next = new Map(previous);
      for (const file of rows) {
        const current = previous.get(file.path) ?? effectiveMappings.get(file.path);
        const changed = update(current ?? { path: file.path, directory: null, strip: 0, file: null }, file);
        if (!changed.directory && !changed.strip && !changed.file && !directoryMatches.has(file.path))
          next.delete(file.path);
        else next.set(file.path, changed);
      }
      return next;
    });
    setPreview(null);
    setError(null);
  };
  const chooseBase = (row: PatchFile) => {
    const defaultPath = effectiveMappings.get(row.path)?.file ?? repo ?? root ?? undefined;
    void choosePath({ directory: false, title: t("Select Base File"), defaultPath })
      .then((file) => {
        if (file) updateMappings([row], (current) => ({ ...current, file, directory: null, strip: 0 }));
      })
      .catch((reason) => setError(errorMessage(reason)));
  };
  const chooseDirectory = (rows: readonly PatchFile[]) => {
    const defaultPath = effectiveMappings.get(rows[0]!.path)?.directory ?? base ?? repo ?? root ?? undefined;
    void choosePath({ directory: true, title: t("Map Directory…"), defaultPath })
      .then((directory) => {
        if (directory) updateMappings(rows, (current) => ({ ...current, directory, file: null }));
      })
      .catch((reason) => setError(errorMessage(reason)));
  };
  const directoryItems = (row: PatchFile): MenuItem[] => {
    const current = effectiveMappings.get(row.path);
    const candidates = directoryMatches.get(row.path) ?? [];
    const isCurrent = (candidate: (typeof candidates)[number]) =>
      current?.directory === candidate.directory && current.strip === candidate.strip;
    if (!candidates.some((candidate) => !isCurrent(candidate))) return [];
    return [
      ...candidates.map((candidate) => ({
        id: candidate.source,
        label: displayPath(candidate.source, root),
        verbatim: true,
        icon: candidate.applies === false ? "warning" : "folder",
        checked: isCurrent(candidate),
        hint: candidate.source,
        run: () =>
          updateMappings([row], (current) => ({
            ...current,
            directory: candidate.directory,
            strip: candidate.strip,
            file: null,
          })),
      })),
      { kind: "separator" },
      { id: "vcs.patch.browseDirectory", label: "Choose Directory…", run: () => chooseDirectory([row]) },
    ];
  };
  const chooseMissing = (row: PatchFile, owner?: HTMLElement) => {
    const choices = directoryItems(row);
    if (!choices.length) {
      chooseBase(row);
      return;
    }
    const bounds = owner?.getBoundingClientRect();
    showContextMenu(
      bounds ? { x: bounds.left, y: bounds.bottom } : "center",
      [...choices, { id: "vcs.patch.selectBase", label: "Select Base File…", run: () => chooseBase(row) }],
      { owner, title: "Choose Matching Directory" },
    );
  };
  const mappingItems = (rows: readonly PatchFile[]): MenuItem[] => {
    const first = rows[0]!;
    const directories = rows.filter((file) => !effectiveMappings.get(file.path)?.file);
    const canStrip = directories.some((file) => (effectiveMappings.get(file.path)?.strip ?? 0) < maxPatchStrip(file));
    const canRestore = directories.some((file) => !!effectiveMappings.get(file.path)?.strip);
    const candidates = rows.length === 1 ? directoryItems(first) : [];
    return [
      ...(rows.length === 1 && (first.missingBase || effectiveMappings.get(first.path)?.file)
        ? [{ id: "vcs.patch.selectBase", label: "Select Base File…", run: () => chooseBase(first) }]
        : []),
      {
        id: "vcs.patch.mapDirectory",
        label: "Map Directory…",
        icon: "folder",
        submenu: candidates.length ? candidates : undefined,
        run: () => chooseDirectory(rows),
      },
      { kind: "separator" },
      {
        id: "vcs.patch.stripDirectory",
        label: "Remove Leading Directory",
        disabled: !canStrip,
        run: () =>
          updateMappings(directories, (current, file) => ({
            ...current,
            strip: Math.min(maxPatchStrip(file), current.strip + 1),
          })),
      },
      {
        id: "vcs.patch.stripAllDirectories",
        label: "Remove All Leading Directories",
        disabled: !canStrip,
        run: () => updateMappings(directories, (current, file) => ({ ...current, strip: maxPatchStrip(file) })),
      },
      {
        id: "vcs.patch.restoreDirectory",
        label: "Restore Leading Directory",
        disabled: !canRestore,
        run: () => updateMappings(directories, (current) => ({ ...current, strip: Math.max(0, current.strip - 1) })),
      },
      {
        id: "vcs.patch.restoreAllDirectories",
        label: "Restore All Leading Directories",
        disabled: !canRestore,
        run: () => updateMappings(directories, (current) => ({ ...current, strip: 0 })),
      },
      {
        id: "vcs.patch.resetMapping",
        label: "Reset Path Mapping",
        disabled: !rows.some((file) => {
          const map = effectiveMappings.get(file.path);
          return !!(map?.directory || map?.strip || map?.file);
        }),
        run: () => updateMappings(rows, (current) => ({ ...current, directory: null, strip: 0, file: null })),
      },
    ];
  };
  const selectedFiles = (keys: ReadonlySet<string>, fallback?: PatchFile) => {
    const rows = files?.filter((file) => keys.has(file.path)) ?? [];
    return rows.length ? rows : fallback ? [fallback] : [];
  };
  const run = async () => {
    if (!selected || !validList) return;
    const projectRoot = useProject.getState().project?.root;
    const changelist = staging ? null : existingList ? { id: existingList.id } : { name: chosenName.trim() };
    const paths = selected === count ? null : included.map((f) => f.path);
    onClose();
    await saveAll();
    if (useProject.getState().project?.root !== projectRoot) return;
    const title = t`Apply patch (${source})`;
    const result = await runOp(
      title,
      async () => {
        if (mapped) return call(commands.vcsApplyMappedPatch(repo, base ?? null, patch, paths, mapped));
        if (base) return call(commands.vcsApplyProjectPatch(base, patch, paths));
        const outcome = await call(commands.vcsApplyPatch(repo, patch, paths));
        return { outcome, failures: [], conflictedRepositories: repo ? [repo] : undefined };
      },
      { refresh: false },
    );
    if (!result || useProject.getState().project?.root !== projectRoot) return;
    if (result.outcome.applied.length || result.outcome.conflicts.length) {
      await reportApply(
        result.outcome,
        result.failures.length ? t("Patch partially applied") : t("Patch applied"),
        result.conflictedRepositories,
        changelist
          ? () =>
              assignPatchChangelist(
                [...result.outcome.applied, ...result.outcome.conflicts].map((path) =>
                  repositoryPath(mapped ? null : (base ?? repo), path),
                ),
                changelist,
                projectRoot,
              )
          : undefined,
      );
    } else await refreshNow();
    if (result.failures.length) {
      const body = result.failures.map(({ root, error }) => `${root}: ${error.message}`).join("\n");
      logConsole("err", body);
      notifications().notify({
        group: "vcs",
        level: "error",
        title: t("Could not apply patch to these repositories"),
        body,
      });
    }
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
        {
          label: "Apply",
          role: "default",
          autoFocus: true,
          disabled: !selected || !validList,
          onClick: () => void run(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={previewStyles.preview}>
        <div className={previewStyles.fields}>
          <label className={previewStyles.field}>
            <T>Patch source</T>
            <Input readOnly value={sourcePath ?? source} title={sourcePath ?? undefined} />
          </label>
          {roots.length > 1 || base || (root && repo && root !== repo) ? (
            <div className={previewStyles.field}>
              <span>
                <T>Patch target</T>
              </span>
              <Select
                aria-label="Patch target"
                title={base ?? repo ?? undefined}
                value={choice ?? (base ? PROJECT_PATCH_TARGET : repo)}
                options={[
                  { value: PROJECT_PATCH_TARGET, label: t("Project paths"), detail: base ?? root ?? undefined },
                  ...roots.map((value) => ({ value, label: baseName(value), detail: value })),
                ]}
                onChange={(value) => {
                  if (choice === value) return;
                  setChoice(value);
                  setPreview(null);
                  setError(null);
                }}
              />
            </div>
          ) : (
            repo && (
              <label className={previewStyles.field}>
                <T>Repository</T>
                <Input readOnly value={repo} title={repo} />
              </label>
            )
          )}
          {!staging && (
            <div className={previewStyles.field}>
              <T>Target changelist</T>
              <ChangelistNamePicker
                field={{
                  "aria-label": "Target changelist",
                  value: chosenName,
                  disabled: !listsLoaded,
                  invalid: !chosenName.trim(),
                  onChange: (event) => setListName(event.target.value),
                }}
                options={lists.lists.map((list) => ({
                  value: list.name,
                  label: list.id === lists.active ? t`${list.name} (active)` : list.name,
                  verbatim: true,
                }))}
                newName={!!chosenName.trim() && !existingList}
                onChoose={setListName}
              />
            </div>
          )}
        </div>
        <section
          ref={fileList}
          className={previewStyles.files}
          onKeyDown={(event) => {
            if (
              event.key !== " " ||
              event.target !== event.currentTarget.querySelector('[role="tree"]') ||
              !activeFile ||
              (placements.get(activeFile.path)?.error && !needsDirectory(activeFile))
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (needsDirectory(activeFile)) chooseMissing(activeFile);
            else toggle(activeFile);
          }}
        >
          <div className={previewStyles.filesHeader}>
            <div className={previewStyles.filesHeading}>
              <Checkbox
                aria-label="Include all files"
                checked={available.length > 0 && selected === available.length}
                indeterminate={selected > 0 && selected < available.length}
                disabled={!available.length}
                onChange={(checked) => setExcluded(new Set(checked ? [] : files?.map((f) => f.path)))}
              />
              <h2 className={previewStyles.heading}>
                <T>Patch files</T>
              </h2>
              <IconButton
                icon="diff"
                title="Show Diff"
                shortcut={shortcutLabel("vcs.showDiff")}
                size="small"
                disabled={!activeFile || activeFile.missingBase || !!placements.get(activeFile.path)?.error}
                onClick={() => activeFile && showDiff(activeFile)}
              />
              <IconButton
                icon="folder"
                title="Change Directory Paths"
                aria-haspopup="menu"
                size="small"
                disabled={!activeFile}
                onClick={(event) => {
                  const rows = selectedFiles(highlighted, activeFile);
                  if (!rows.length) return;
                  const { left: x, bottom: y } = event.currentTarget.getBoundingClientRect();
                  showContextMenu({ x, y }, mappingItems(rows), { owner: event.currentTarget });
                }}
              />
            </div>
            {files && (
              <span className={previewStyles.stats}>
                {selected !== count
                  ? t`${selected} of ${count} selected`
                  : count === 1
                    ? t`${count} file`
                    : t`${count} files`}
              </span>
            )}
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
            <Tree
              roots={files}
              getKey={(f) => f.path}
              getLabel={(f) => placements.get(f.path)?.target ?? f.path}
              getChildren={() => undefined}
              isExpandable={() => false}
              multiSelect
              selected={highlighted}
              onSelectionChange={(keys, file) => {
                setHighlighted(keys);
                setActivePath(file?.path ?? null);
              }}
              onActivate={(file) => {
                if (needsDirectory(file)) chooseMissing(file);
                else showDiff(file);
              }}
              onContextMenu={(file, keys, event) => {
                const rows = selectedFiles(keys, file ?? undefined);
                if (rows.length) showContextMenu(event, mappingItems(rows));
              }}
              aria-label="Patch files"
              className={previewStyles.tree}
              empty={<T>No changes</T>}
              renderNode={(file) => (
                <PatchFileRow
                  file={file}
                  placement={placements.get(file.path)}
                  projectRoot={root}
                  hasDirectoryMatches={directoryMatches.has(file.path)}
                  checked={!excluded.has(file.path) && !file.missingBase && !placements.get(file.path)?.error}
                  onChange={() => toggle(file)}
                  onChooseBase={(owner) => chooseMissing(file, owner)}
                />
              )}
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
