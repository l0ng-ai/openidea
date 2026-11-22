/**
 * Commit checks (Settings › Version Control › Commit / Git): before-commit
 * modifications (Reformat code, Optimize imports, Cleanup) applied through
 * the language servers, then the checks registered through
 * `commitCheckRegistry` (Analyze code, Check TODO) and the Git warnings
 * (detached HEAD / rebase, file names, large files, CRLF line separators).
 */
import type { ReactNode } from "react";
import { ChangeSet, Text } from "@codemirror/state";
import type {
  FileStatus,
  FormatOptions,
  HunkRange,
  PartialCommitFile,
  Pos,
  PreparedPartialCommit,
  TextEdit,
} from "@/bindings";
import { offsetsToRange, textEditsToChanges } from "@/editor/api";
import { formatExcluded, formatGuardOptions, guardTextEdits } from "@/platform/formatGuard";
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { maybeEditorService } from "@/workbench/contributions";
import { addedThenDeleted, renamedFromPath } from "./changes";
import { workingText } from "./commitContents";
import { analyzeCommit, problemCounts } from "./commitAnalysis";
import { baseName, effectiveKind, relTo, repoLabel, rootOf, stripSlash } from "./model";
import { logConsole } from "./ops";
import { useVcs } from "./store";
import { commitTodoRules, todoCheckResult, todosForCommit } from "./commitTodo";
import { commitTestSelection, runCommitTests } from "./commitTests";
import { stopPendingPostCommitTests } from "./postCommitChecks";
import { hunkKeys, rollbackEdit } from "./hunks";
import { keepsExcludedChanges, partialCommitProjection } from "./partialCommitProjection";
import type { CommitCheck, CommitCheckContext, CommitFix } from "./commitCheckRegistry";
import { getCommitChecks, registerCommitCheck } from "./commitCheckRegistry";
import { tx } from "@/platform/i18n";

// ---------------------------------------------------------------------------
// Headless modifications through the language server

function wholeRange(text: string) {
  const lines = text.split("\n");
  return { start: { line: 0, col: 0 }, end: { line: lines.length - 1, col: lines[lines.length - 1]!.length } };
}

async function applyKind(doc: number, text: string, kind: string): Promise<boolean> {
  const actions = (await call(commands.lspCodeActions(doc, wholeRange(text), [kind]))).filter(
    (a) => a.kind?.startsWith(kind) && !a.disabledReason,
  );
  const action = actions.find((a) => a.isPreferred) ?? actions[0];
  if (!action) return false;
  await call(commands.lspApplyCodeAction(doc, action));
  return true;
}

interface Modifications {
  reformat: boolean;
  optimizeImports: boolean;
  cleanup: boolean;
}

const SOURCE_MODIFICATIONS = [
  { setting: "optimizeImports", title: "Optimize imports", kind: "source.organizeImports" },
  { setting: "cleanup", title: "Cleanup", kind: "source.fixAll" },
] as const;

function sameHunk(a: HunkRange, b: HunkRange): boolean {
  return a.start === b.start && a.lines === b.lines && a.oldStart === b.oldStart && a.oldLines === b.oldLines;
}

async function formatChangedText(
  file: FileStatus,
  text: string,
  partial: PartialCommitFile | undefined,
  format: (options: FormatOptions) => Promise<TextEdit[]>,
): Promise<{ edits: TextEdit[]; formatted: string } | null> {
  const path = stripSlash(file.path);
  const { project, settings } = useProject.getState();
  const guard = formatGuardOptions(settings);
  if (formatExcluded(path, project?.root ?? null, guard.doNotFormat)) return null;
  const base = (await call(commands.vcsFileAt(renamedFromPath(file) ?? path, "HEAD"))) ?? "";
  const hunks = await commands.vcsDiffHunks(base, text);
  const selected = partial ? hunks.filter((h) => partial.hunks.some((want) => sameHunk(want, h))) : hunks;
  if (partial && selected.length !== partial.hunks.length) return null;
  const changedLines = selected.filter((h) => h.lines > 0);
  if (!changedLines.length) return null;

  const editor = settings?.editor;
  const edits = guardTextEdits(
    text,
    await format({ tabSize: editor?.tabSize ?? 4, insertSpaces: editor?.insertSpaces ?? true }),
    guard,
  ).filter(({ range }) => changedLines.some((h) => range.start.line >= h.start && range.end.line < h.start + h.lines));
  if (!edits.length) return null;
  const document = Text.of(text.split("\n"));
  const offset = ({ line, col }: Pos) => document.line(line + 1).from + col;
  const formatted = ChangeSet.of(
    edits.map(({ range, new_text }) => ({ from: offset(range.start), to: offset(range.end), insert: new_text })),
    document.length,
  )
    .apply(document)
    .toString();

  if (partial) {
    // If diff alignment or duplicate hunk keys changed, the saved exclusions
    // would select different text on the next read. Keep the original selection.
    const updated = await commands.vcsDiffHunks(base, formatted);
    const oldKeys = hunkKeys(text, hunks);
    const newKeys = hunkKeys(formatted, updated);
    const valid = hunks.every(
      (h, i) =>
        selected.includes(h) ||
        updated.some(
          (next, j) => next.oldStart === h.oldStart && next.oldLines === h.oldLines && oldKeys[i] === newKeys[j],
        ),
    );
    if (!valid) return null;
  }
  return { edits, formatted };
}

async function previewStagedFormatting(file: FileStatus, before: string) {
  if (before.includes("\0")) return;
  const path = stripSlash(file.path);
  return formatChangedText(file, before, undefined, (options) => call(commands.lspFormatText(path, before, options)));
}

export async function prepareSnapshotModifications(
  file: FileStatus,
  before: string,
  mods: Modifications,
  isCurrent: () => boolean,
  accept?: (changes: ChangeSet) => boolean,
) {
  const path = stripSlash(file.path);
  const original = Text.of(before.split("\n"));
  let doc = original;
  let changes = ChangeSet.empty(doc.length);
  const apply = async (edits: readonly TextEdit[]) => {
    if (!edits.length) return;
    const next = ChangeSet.of(textEditsToChanges(doc, edits), doc.length);
    const updated = next.apply(doc);
    let composed = changes.compose(next);
    if (accept && !accept(composed)) {
      // Some servers return a full-document replacement for a small edit.
      const hunks = await commands.vcsDiffHunks(updated.toString(), before);
      composed = ChangeSet.of(
        hunks.map((h) => rollbackEdit(before, h)),
        original.length,
      );
      if (!accept(composed) || !composed.apply(original).eq(updated)) return;
    }
    changes = composed;
    doc = updated;
  };
  for (const { setting, kind, title } of SOURCE_MODIFICATIONS) {
    if (!isCurrent()) return;
    if (!mods[setting]) continue;
    try {
      await apply(await call(commands.lspSourceActionText(path, doc.toString(), kind, nextRequestId())));
    } catch (error) {
      logConsole("info", `${title} skipped for ${baseName(path)}: ${failureText(error)}`);
    }
  }
  if (!isCurrent()) return;
  if (mods.reformat) {
    try {
      const result = await previewStagedFormatting(file, doc.toString());
      if (result) await apply(result.edits);
    } catch (error) {
      logConsole("info", `Reformat code skipped for ${baseName(path)}: ${failureText(error)}`);
    }
  }
  const text = doc.toString();
  if (text === before || !isCurrent()) return;
  return { text, edits: editsFromChanges(original, changes), changes };
}

function editsFromChanges(original: Text, changes: ChangeSet): TextEdit[] {
  const edits: TextEdit[] = [];
  changes.iterChanges((from, to, _fromB, _toB, insert) => {
    edits.push({ range: offsetsToRange(original, from, to), new_text: insert.toString() });
  });
  return edits;
}

export interface PartialCommitModification {
  path: string;
  prepared: PreparedPartialCommit;
  workingBefore: string;
  workingEdits: TextEdit[];
}

async function preparePartialModifications(file: FileStatus, partial: PartialCommitFile, mods: Modifications) {
  const path = stripSlash(file.path);
  const project = useProject.getState().project;
  const isCurrent = () => useProject.getState().project === project;
  const [text, current, head] = await Promise.all([
    call(commands.vcsPreviewPartialCommit(partial)),
    workingText(path),
    call(commands.vcsFileAt(path, "HEAD")),
  ]);
  if (current === null || head === null || !isCurrent()) return;
  const before = text.replace(/\r\n?/g, "\n");
  const working = Text.of(current.split("\n"));
  const hunks = await commands.vcsDiffHunks(head, current);
  const excluded = partialCommitProjection(working, Text.of(before.split("\n")), hunks, partial);
  if (!excluded) return;
  const accept = (changes: ChangeSet) => keepsExcludedChanges(changes, excluded);
  const result = await prepareSnapshotModifications(file, before, mods, isCurrent, accept);
  if (!result) return;
  const workingEdits = editsFromChanges(working, result.changes.map(excluded));
  return { path, prepared: { before, text: result.text }, workingBefore: current, workingEdits };
}

export async function syncCommitEdits(path: string, before: string, edits: TextEdit[], isCurrent: () => boolean) {
  const doc = await call(commands.docOpen(path));
  try {
    if (doc.large || doc.readOnly || !isCurrent()) return;
    const snapshot = await call(commands.docSnapshot(doc.id));
    if (snapshot.dirty || snapshot.text !== before || !isCurrent()) return;
    await call(commands.applyWorkspaceEdit({ files: [{ kind: "edit", path, edits, version: snapshot.version }] }));
    await call(commands.docAutosave(doc.id));
  } finally {
    void commands.docClose(doc.id);
  }
}

async function formatStagedText(file: FileStatus, before: string) {
  if (before.includes("\0")) return;
  const path = stripSlash(file.path);
  const mode = await call(commands.vcsFileMode(path, ":0"));
  if (mode !== "100644" && mode !== "100755") return;
  const result = await previewStagedFormatting(file, before);
  if (result) await call(commands.vcsStageFormattedText(path, before, result.formatted));
}

/** Applies the enabled modifications to one file and saves it. Errors are logged, not thrown. */
async function modifyFile(
  file: FileStatus,
  mods: Modifications,
  partial: PartialCommitFile | undefined,
  index: boolean,
) {
  const path = stripSlash(file.path);
  if (index && (mods.optimizeImports || mods.cleanup)) {
    const project = useProject.getState().project;
    const isCurrent = () => useProject.getState().project === project;
    const staged = await call(commands.vcsStagedText(path));
    if (!staged || !isCurrent()) return;
    const result = await prepareSnapshotModifications(file, staged.text, mods, isCurrent);
    if (!isCurrent()) return;
    if (result) {
      await call(commands.vcsSaveStagedText(path, staged.version, result.text));
      if (file.unstaged === null && isCurrent()) await syncCommitEdits(path, staged.text, result.edits, isCurrent);
      return;
    }
    if (!mods.reformat) return;
  }
  const staged = index ? (await call(commands.vcsFileAt(path, ":0")))?.replace(/\r\n?/g, "\n") : undefined;
  if (index && staged === undefined) return;
  if (staged !== undefined && file.unstaged !== null) {
    await formatStagedText(file, staged);
    return;
  }
  let info;
  try {
    info = await call(commands.docOpen(path));
  } catch {
    return;
  }
  try {
    if (info.readOnly || info.large) return;
    const step = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        logConsole("info", `${label} skipped for ${baseName(path)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    if (!partial && !index)
      for (const { setting, kind, title } of SOURCE_MODIFICATIONS) {
        if (mods[setting])
          await step(title, async () => applyKind(info.id, (await call(commands.docSnapshot(info.id))).text, kind));
      }
    if (mods.reformat)
      await step("Reformat code", async () => {
        const snapshot = await call(commands.docSnapshot(info.id));
        if (staged !== undefined && snapshot.text !== staged) {
          await formatStagedText(file, staged);
          return;
        }
        const result = await formatChangedText(file, snapshot.text, partial, (options) =>
          call(commands.lspFormat(info.id, null, options)),
        );
        if (!result) return;
        await call(
          commands.applyWorkspaceEdit({
            files: [{ kind: "edit", path, edits: result.edits, version: snapshot.version }],
          }),
        );
        if (staged === undefined) return;
        await call(commands.docSave(info.id));
        await call(commands.vcsStageFormattedText(path, staged, result.formatted));
      });
    if (!index) await call(commands.docSave(info.id));
  } finally {
    void commands.docClose(info.id);
  }
}

/**
 * The before-commit modifications, as one ordered step ahead of the checks: they
 * rewrite the files the analysis and TODO checks read, and they report no result
 * of their own. Errors are logged, never thrown.
 */
export async function runCommitModifications(
  included: readonly FileStatus[],
  selection: CommitCheckContext["selection"],
): Promise<PartialCommitModification[]> {
  const { commit } = workflowSettings().vcs;
  const mods: Modifications = {
    reformat: commit.reformat,
    optimizeImports: commit.optimizeImports,
    cleanup: commit.cleanup,
  };
  if (!mods.reformat && !mods.optimizeImports && !mods.cleanup) return [];
  if (!isTauri() || !included.length) return [];
  const { repositories } = await selection();
  const working = new Set(repositories.flatMap(({ options }) => options.stage ?? []));
  const partial = new Map(
    repositories.flatMap(({ options }) => options.partial ?? []).map((file) => [file.path, file]),
  );
  const prepared: PartialCommitModification[] = [];
  logConsole(
    "info",
    `Before commit: ${[mods.optimizeImports && "optimize imports", mods.cleanup && "cleanup", mods.reformat && "reformat code"].filter(Boolean).join(", ")}`,
  );
  for (const file of included) {
    const path = stripSlash(file.path);
    const blocks = partial.get(path);
    const index = !working.has(path) && !blocks;
    if (index ? file.staged === "deleted" : file.unstaged === "deleted") continue;
    try {
      if (blocks && (mods.optimizeImports || mods.cleanup || blocks.lineHunks?.length)) {
        const modification = await preparePartialModifications(file, blocks, mods);
        if (modification) prepared.push(modification);
      } else {
        await modifyFile(file, mods, blocks, index);
      }
    } catch (e) {
      logConsole("info", `Before-commit edits skipped for ${baseName(path)}: ${failureText(e)}`);
    }
  }
  if (mods.optimizeImports || mods.cleanup)
    try {
      await maybeEditorService()?.saveAll();
    } catch {
      // best effort
    }
  return prepared;
}

// ---------------------------------------------------------------------------
// Problems

/**
 * A before-commit problem, shown in the commit panel (as IDEA). Errors hold the
 * commit back while the Commit button turns into "Commit Anyway"; warnings are
 * shown without stopping it.
 */
export interface CommitProblem {
  title: string;
  text: ReactNode;
  /** "Review" / "Show details" link. */
  details?: CommitFix;
}

// ---------------------------------------------------------------------------
// Git: names invalid on Windows, large files

const WINDOWS_RESERVED = new Set(
  ["CON", "PRN", "AUX", "NUL"].concat([1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`])),
);
// eslint-disable-next-line no-control-regex
const WINDOWS_INVALID = /[<>:"\\|?*\u0000-\u001f]/;

/** The first path segment below `root` that Windows rejects (IDEA's GitFileNameCheckinHandler). */
export function badFileName(
  paths: readonly string[],
  root: string,
): { name: string; kind: "reserved" | "char" } | null {
  for (const p of paths) {
    for (const name of relTo(root, p).split("/")) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      if (WINDOWS_RESERVED.has(stem.toUpperCase())) return { name, kind: "reserved" };
      if (WINDOWS_INVALID.test(name)) return { name, kind: "char" };
    }
  }
  return null;
}

async function commitRepoFiles(ctx: CommitCheckContext) {
  const { repositories } = await ctx.selection();
  const roots = useVcs.getState().roots;
  const paths = ctx.included.map(({ path }) => stripSlash(path));
  return repositories.map(({ root, options }) => ({
    root,
    options,
    paths: paths.filter((path) => (rootOf(path, roots) ?? (repositories.length === 1 ? root : null)) === root),
  }));
}

async function commitHeadProblem(ctx: CommitCheckContext) {
  if (!ctx.settings.git.warnDetachedHead) return null;
  const { repositories } = await ctx.selection();
  const { heads, operations } = useVcs.getState();
  for (const { root } of repositories) {
    const head = heads[root];
    if (head?.headCommit && !head.head && !head.interactiveRebase) {
      return { name: repoLabel(root, ctx.root), rebase: operations[root] === "rebase" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Built-in checks, in the order they are reported

/** Every built-in check stops the commit (Commit Anyway goes on), as before the registry. */
const builtinChecks: readonly CommitCheck[] = [
  {
    id: "vcs.rebase",
    title: "Commit during rebase",
    order: 10,
    run: async (ctx) => {
      const problem = await commitHeadProblem(ctx);
      if (!problem?.rebase) return null;
      return {
        severity: "error",
        text: tx`A rebase is in progress in ${problem.name}. A commit created during this rebase may be lost.`,
        fix: { label: "More about Git rebase", run: () => openExternalUrl("https://git-scm.com/docs/git-rebase") },
      };
    },
  },
  {
    id: "vcs.detachedHead",
    title: "Commit in detached HEAD",
    order: 11,
    run: async (ctx) => {
      const problem = await commitHeadProblem(ctx);
      if (!problem || problem.rebase) return null;
      return {
        severity: "error",
        text: tx`${problem.name} is in detached HEAD. Create a branch to keep new commits.`,
        fix: {
          label: "More about detached HEAD",
          run: () => openExternalUrl("https://git-scm.com/docs/git-checkout#_detached_head"),
        },
      };
    },
  },
  {
    id: "vcs.fileNames",
    title: "File names",
    order: 20,
    run: (ctx) => {
      if (!ctx.settings.git.warnBadFileNames) return null;
      // New paths only: a name already in the repository is not this commit's problem.
      const kinds = new Map(ctx.status.map((f) => [stripSlash(f.path), effectiveKind(f)]));
      const added = ctx.existing.filter((p) => ["added", "untracked", "renamed"].includes(kinds.get(p) ?? ""));
      const bad = badFileName(added, ctx.root);
      if (!bad) return null;
      return {
        severity: "error",
        text:
          bad.kind === "reserved"
            ? tx`Some files use reserved names that are not allowed on Windows: '${bad.name}'. If you commit, it will not be possible to check out the Git repository on Windows.`
            : tx`Some of the file names contain characters that are not allowed on Windows: '${bad.name}'. If you commit, it might not be possible to check out the Git repository on Windows.`,
      };
    },
  },
  {
    id: "vcs.largeFiles",
    title: "Large files",
    order: 30,
    run: async (ctx) => {
      if (!ctx.settings.git.warnLargeFiles || !ctx.included.length) return null;
      const limit = ctx.settings.git.largeFileMb * 1024 * 1024;
      const large = (
        await Promise.all(
          (await commitRepoFiles(ctx)).map(({ root, paths, options }) =>
            call(commands.vcsCommitLargeFiles(root, paths, options, limit, nextRequestId())).catch(() => []),
          ),
        )
      ).flat();
      if (!large.length) return null;
      const mb = Math.floor(large.reduce((n, f) => n + f.size, 0) / (1024 * 1024));
      return {
        severity: "error",
        text:
          large.length === 1
            ? tx`You are about to commit a large file into the repository: ${baseName(large[0]!.path)} (${mb} MB). It is not recommended to store large files in a Git repository. Consider using Git LFS.`
            : tx`You are about to commit ${large.length} large files into the repository with the total size of ${mb} MB. It is not recommended to store large files in a Git repository. Consider using Git LFS.`,
      };
    },
  },
  {
    id: "vcs.analysis",
    title: "Code analysis",
    order: 40,
    run: async (ctx) => {
      if (!ctx.settings.commit.analyzeCode || !isTauri() || !ctx.included.length) return null;
      return analyzeCommit(ctx);
    },
  },
  {
    id: "vcs.todo",
    title: "TODO",
    order: 50,
    run: async (ctx) => {
      if (!ctx.settings.commit.checkTodo || !isTauri() || !ctx.included.length) return null;
      const rules = commitTodoRules();
      const selection = await ctx.selection();
      const subject = selection.message.trim().split(/\r?\n/, 1)[0] ?? "";
      return todoCheckResult(await todosForCommit(ctx.included, selection, rules), subject);
    },
  },
  {
    id: "vcs.tests",
    title: "Run Tests",
    order: 55,
    run: async (ctx) => {
      const selection = ctx.settings.commit.nonModal && isTauri() ? commitTestSelection() : null;
      if (!selection?.enabled) return null;
      const project = useProject.getState().project;
      await stopPendingPostCommitTests();
      if (useProject.getState().project !== project) return null;
      return runCommitTests(selection);
    },
  },
  {
    id: "vcs.crlf",
    title: "Line separators",
    order: 60,
    run: async (ctx) => {
      if (!ctx.settings.git.warnCrlf || !ctx.included.length) return null;
      const crlf = (
        await Promise.all(
          (await commitRepoFiles(ctx)).map(({ root, paths, options }) =>
            call(commands.vcsCommitCrlfPaths(root, paths, options, nextRequestId())).catch(() => []),
          ),
        )
      ).flat();
      if (!crlf.length) return null;
      const crlfNames = crlf.slice(0, 5).map(baseName).join(", ") + (crlf.length > 5 ? ", …" : "");
      return {
        severity: "error",
        text: (
          <>
            {crlf.length === 1
              ? tx`${crlf.length} selected file has CRLF (${crlfNames}).`
              : tx`${crlf.length} selected files have CRLF (${crlfNames}).`}{" "}
            {tx("Convert to LF via the status bar or run")} <code>git config core.autocrlf input</code>.{" "}
            {tx("Re-stage if needed.")}
          </>
        ),
      };
    },
  },
];

/** Registers the built-in checks; called when the VCS feature activates. */
export function installCommitChecks(): () => void {
  const disposers = builtinChecks.map(registerCommitCheck);
  return () => disposers.reverse().forEach((dispose) => dispose());
}

// ---------------------------------------------------------------------------

/** What the before-commit pipeline found: the problems to show, and whether they hold the commit. */
export interface CommitCheckRun {
  problems: CommitProblem[];
  blocked: boolean;
  /** A blocked commit still has to run the checks that were deferred. */
  deferredAdvancedChecks?: true;
  /** Prepared edits for the same selection when the user chooses Commit Anyway. */
  partialModifications?: PartialCommitModification[];
}

const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs the registered checks for the files
 * about to be committed. `blocked` means a check reported an error (or could not
 * run): the commit waits for Commit Anyway; warnings are shown without stopping it.
 */
export async function runCommitChecks(
  included: readonly FileStatus[],
  amend: boolean,
  selection: CommitCheckContext["selection"],
  scope?: Partial<Pick<CommitCheckContext, "root" | "status">> & { advancedChecks?: "omit" | "only" },
): Promise<CommitCheckRun> {
  const { commit, git } = workflowSettings().vcs;
  const { root, status } = useVcs.getState();
  const ctx: CommitCheckContext = {
    existing: included
      .filter((f) => effectiveKind(f) !== "deleted" && !addedThenDeleted(f))
      .map((f) => stripSlash(f.path)),
    included,
    selection,
    amend,
    root: scope?.root ?? root ?? "",
    status: scope?.status ?? status,
    settings: { commit, git },
    diagnostics: problemCounts,
  };
  const problems: CommitProblem[] = [];
  let blocked = false;
  for (const check of getCommitChecks()) {
    const advanced = check.id === "vcs.analysis" || check.id === "vcs.todo" || check.id === "vcs.tests";
    if (scope?.advancedChecks && advanced !== (scope.advancedChecks === "only")) continue;
    try {
      const result = await check.run(ctx);
      if (!result) continue;
      problems.push({ title: check.title, text: result.text, details: result.fix });
      if (result.severity === "error") blocked = true;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // A broken check must not break the commit: report it and let Commit Anyway go on.
      problems.push({ title: check.title, text: tx`The check could not run: ${failureText(e)}` });
      blocked = true;
    }
  }
  return { problems, blocked };
}
