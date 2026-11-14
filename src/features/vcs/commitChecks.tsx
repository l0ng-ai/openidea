/**
 * Commit checks (Settings › Version Control › Commit / Git): before-commit
 * modifications (Reformat code, Optimize imports, Cleanup) applied through
 * the language servers, then the checks registered through
 * `commitCheckRegistry` (Analyze code, Check TODO) and the Git warnings
 * (detached HEAD / rebase, file names, large files, CRLF line separators).
 */
import type { ReactNode } from "react";
import type { Diagnostic } from "@/bindings";
import { formatExcluded, formatGuardOptions, guardTextEdits } from "@/platform/formatGuard";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { maybeEditorService, toolWindowService } from "@/workbench/contributions";
import { baseName, effectiveKind, relTo, stripSlash } from "./model";
import { logConsole } from "./ops";
import { useVcs } from "./store";
import type { CommitCandidate, CommitCheck, CommitCheckContext } from "./commitCheckRegistry";
import { getCommitChecks, registerCommitCheck } from "./commitCheckRegistry";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

// ---------------------------------------------------------------------------
// Diagnostics seen per file (Analyze code)

const diagnostics = new Map<string, Map<string, Diagnostic[]>>();
/** Paths that received at least one diagnostics event. */
const analyzed = new Set<string>();
const waiters = new Set<() => void>();

export function installDiagnosticsTracking(): () => void {
  return onIdeEvent("diagnostics", (e) => {
    let sources = diagnostics.get(e.path);
    if (!sources) diagnostics.set(e.path, (sources = new Map()));
    if (e.items.length) sources.set(e.source, e.items);
    else sources.delete(e.source);
    analyzed.add(e.path);
    waiters.forEach((w) => w());
  });
}

export function problemCounts(paths: readonly string[]): { errors: number; warnings: number; files: number } {
  let errors = 0;
  let warnings = 0;
  let files = 0;
  for (const p of paths) {
    const items = [...(diagnostics.get(p)?.values() ?? [])].flat();
    const e = items.filter((d) => d.severity === "error").length;
    const w = items.filter((d) => d.severity === "warning").length;
    errors += e;
    warnings += w;
    if (e + w) files++;
  }
  return { errors, warnings, files };
}

/** Waits until every path was analysed (or `timeout`). */
function waitForAnalysis(paths: readonly string[], timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (paths.every((p) => analyzed.has(p))) finish();
    };
    const timer = setTimeout(() => finish(), timeout);
    const finish = () => {
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
}

// ---------------------------------------------------------------------------
// TODO items in added lines

const TODO_RE = /\b(TODO|FIXME)\b/i;

export interface TodoHit {
  path: string;
  /** 0-based line in the working text. */
  line: number;
  text: string;
}

/** TODO / FIXME in lines added or changed relative to `oldText`. */
export async function todosInChanges(path: string, oldText: string, newText: string): Promise<TodoHit[]> {
  const hunks = await commands.vcsDiffHunks(oldText, newText);
  const lines = newText.split("\n");
  const out: TodoHit[] = [];
  for (const h of hunks) {
    for (let l = h.start; l < h.start + h.lines; l++) {
      const text = lines[l] ?? "";
      if (TODO_RE.test(text)) out.push({ path, line: l, text: text.trim() });
    }
  }
  return out;
}

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

export interface Modifications {
  reformat: boolean;
  optimizeImports: boolean;
  cleanup: boolean;
}

/** Applies the enabled modifications to one file and saves it. Errors are logged, not thrown. */
async function modifyFile(path: string, mods: Modifications) {
  let info;
  try {
    info = await call(commands.docOpen(path));
  } catch {
    return;
  }
  try {
    const step = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        logConsole("info", `${label} skipped for ${baseName(path)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    if (mods.optimizeImports)
      await step("Optimize imports", async () =>
        applyKind(info.id, (await call(commands.docSnapshot(info.id))).text, "source.organizeImports"),
      );
    if (mods.cleanup)
      await step("Cleanup", async () =>
        applyKind(info.id, (await call(commands.docSnapshot(info.id))).text, "source.fixAll"),
      );
    const { project, settings } = useProject.getState();
    const guard = formatGuardOptions(settings);
    if (mods.reformat && !formatExcluded(path, project?.root ?? null, guard.doNotFormat))
      await step("Reformat code", async () => {
        const editor = settings?.editor as { tabSize?: number; insertSpaces?: boolean } | undefined;
        const text = (await call(commands.docSnapshot(info.id))).text;
        const edits = guardTextEdits(
          text,
          await call(
            commands.lspFormat(info.id, null, {
              tabSize: editor?.tabSize ?? 4,
              insertSpaces: editor?.insertSpaces ?? true,
            }),
          ),
          guard,
        );
        if (edits.length) await call(commands.applyWorkspaceEdit({ files: [{ kind: "edit", path, edits }] }));
      });
    await call(commands.docSave(info.id));
  } finally {
    void commands.docClose(info.id);
  }
}

/**
 * The before-commit modifications, as one ordered step ahead of the checks: they
 * rewrite the files the analysis and TODO checks read, and they report no result
 * of their own. Errors are logged, never thrown.
 */
async function modifyFiles(ctx: CommitCheckContext) {
  const { commit } = ctx.settings;
  const mods: Modifications = {
    reformat: commit.reformat,
    optimizeImports: commit.optimizeImports,
    cleanup: commit.cleanup,
  };
  if (!mods.reformat && !mods.optimizeImports && !mods.cleanup) return;
  if (!isTauri() || !ctx.existing.length) return;
  logConsole(
    "info",
    `Before commit: ${[mods.optimizeImports && "optimize imports", mods.cleanup && "cleanup", mods.reformat && "reformat code"].filter(Boolean).join(", ")}`,
  );
  for (const p of ctx.existing) await modifyFile(p, mods);
  try {
    await maybeEditorService()?.saveAll();
  } catch {
    // best effort
  }
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
  details?: { label: string; run: () => void };
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

/** Files bigger than `limit` bytes; sizes come from listing their folders. */
async function largeFiles(paths: readonly string[], limit: number): Promise<Array<{ path: string; size: number }>> {
  const byDir = new Map<string, Set<string>>();
  for (const p of paths) {
    const dir = p.slice(0, p.lastIndexOf("/")) || "/";
    (byDir.get(dir) ?? byDir.set(dir, new Set()).get(dir)!).add(p);
  }
  const out: Array<{ path: string; size: number }> = [];
  for (const [dir, wanted] of byDir) {
    try {
      for (const e of await call(commands.fsReadDir(dir)))
        if (wanted.has(e.path) && e.kind === "file" && e.size > limit) out.push({ path: e.path, size: e.size });
    } catch {
      // unreadable folder
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in checks, in the order they are reported

/** Every built-in check stops the commit (Commit Anyway goes on), as before the registry. */
const builtinChecks: readonly CommitCheck[] = [
  {
    id: "vcs.rebase",
    title: "Commit during rebase",
    order: 10,
    run: (ctx) =>
      ctx.settings.git.warnDetachedHead && ctx.branch?.operation === "rebase"
        ? {
            severity: "error",
            text: "A rebase is in progress. The commit will become part of the rebased history; usually you continue the rebase instead.",
          }
        : null,
  },
  {
    id: "vcs.detachedHead",
    title: "Commit in detached HEAD",
    order: 11,
    run: (ctx) =>
      ctx.settings.git.warnDetachedHead && ctx.branch && !ctx.branch.head && ctx.branch.operation !== "rebase"
        ? {
            severity: "error",
            text: "HEAD is detached: the commit won't belong to any branch and may be lost after checking out another branch. Create a branch first to keep it.",
          }
        : null,
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
      if (!ctx.settings.git.warnLargeFiles || !isTauri() || !ctx.existing.length) return null;
      const large = await largeFiles(ctx.existing, ctx.settings.git.largeFileMb * 1024 * 1024);
      if (!large.length) return null;
      const mb = Math.ceil(large.reduce((n, f) => n + f.size, 0) / (1024 * 1024));
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
      if (!ctx.settings.commit.analyzeCode || !isTauri() || !ctx.existing.length) return null;
      // Opening the files makes their language servers analyse them.
      const opened: number[] = [];
      for (const p of ctx.existing.filter((p) => !analyzed.has(p))) {
        try {
          opened.push((await call(commands.docOpen(p))).id);
        } catch {
          // binary / unreadable
        }
      }
      try {
        await waitForAnalysis(ctx.existing, opened.length ? 2000 : 0);
      } finally {
        opened.forEach((id) => void commands.docClose(id));
      }
      const { errors, warnings, files: n } = ctx.diagnostics(ctx.existing);
      if (errors + warnings === 0) return null;
      const errorCount = errors === 1 ? tx`${errors} error` : tx`${errors} errors`;
      const warningCount = warnings === 1 ? tx`${warnings} warning` : tx`${warnings} warnings`;
      const found = !warnings ? errorCount : !errors ? warningCount : tx`${errorCount} and ${warningCount}`;
      return {
        severity: "error",
        text: n === 1 ? tx`${found} found in ${n} file` : tx`${found} found in ${n} files`,
        fix: {
          label: "Review",
          run: () => {
            try {
              toolWindowService().show("problems", true);
            } catch {
              // no Problems tool window
            }
          },
        },
      };
    },
  },
  {
    id: "vcs.todo",
    title: "TODO",
    order: 50,
    run: async (ctx) => {
      if (!ctx.settings.commit.checkTodo || !isTauri() || !ctx.existing.length) return null;
      const hits: TodoHit[] = [];
      for (const p of ctx.existing) {
        try {
          const [oldText, newText] = await Promise.all([
            call(commands.vcsFileAt(p, ctx.amend ? "HEAD~1" : "HEAD")).catch(() => null),
            call(commands.fsReadText(p)),
          ]);
          hits.push(...(await todosInChanges(p, oldText ?? "", newText)));
        } catch {
          // unreadable / binary
        }
      }
      if (!hits.length) return null;
      return {
        severity: "error",
        text: (
          <>
            <div>
              {hits.length === 1
                ? tx`${hits.length} TODO item found in the changed lines:`
                : tx`${hits.length} TODO items found in the changed lines:`}
            </div>
            <ul className={styles.todoList}>
              {hits.slice(0, 20).map((h, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() =>
                      void maybeEditorService()?.openFile(h.path, { selection: { line: h.line, col: 0 }, focus: true })
                    }
                  >
                    {relTo(ctx.root, h.path)}:{h.line + 1}
                  </button>{" "}
                  {h.text}
                </li>
              ))}
              {hits.length > 20 && <li>…</li>}
            </ul>
          </>
        ),
      };
    },
  },
  {
    id: "vcs.crlf",
    title: "Line separators",
    order: 60,
    run: async (ctx) => {
      if (!ctx.settings.git.warnCrlf || !isTauri() || !ctx.existing.length) return null;
      const autocrlf = (await call(commands.vcsConfigGet(ctx.repo, "core.autocrlf")).catch(() => null))?.toLowerCase();
      if (autocrlf === "true" || autocrlf === "input") return null;
      const crlf: string[] = [];
      for (const p of ctx.existing) {
        try {
          if ((await call(commands.fsReadText(p))).includes("\r\n")) crlf.push(p);
        } catch {
          // skip
        }
      }
      if (!crlf.length) return null;
      const crlfNames = crlf.slice(0, 5).map(baseName).join(", ") + (crlf.length > 5 ? ", …" : "");
      return {
        severity: "error",
        text: (
          <>
            {crlf.length === 1
              ? tx`${crlf.length} file (${crlfNames}) contain CRLF line separators and core.autocrlf is not set, so they would be committed with CRLF. Convert them with the line separator widget in the status bar, or set`
              : tx`${crlf.length} files (${crlfNames}) contain CRLF line separators and core.autocrlf is not set, so they would be committed with CRLF. Convert them with the line separator widget in the status bar, or set`}{" "}
            <code>git config core.autocrlf input</code>.
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
}

const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs the before-commit modifications, then the registered checks, for the files
 * about to be committed. `blocked` means a check reported an error (or could not
 * run): the commit waits for Commit Anyway; warnings are shown without stopping it.
 */
export async function runCommitChecks(files: readonly CommitCandidate[], amend: boolean): Promise<CommitCheckRun> {
  const { commit, git } = workflowSettings().vcs;
  const { root, repo, status, branch } = useVcs.getState();
  const ctx: CommitCheckContext = {
    files,
    existing: files.filter((f) => f.exists).map((f) => f.path),
    amend,
    root: root ?? "",
    repo,
    status,
    branch,
    settings: { commit, git },
    diagnostics: problemCounts,
  };
  await modifyFiles(ctx);

  const problems: CommitProblem[] = [];
  let blocked = false;
  for (const check of getCommitChecks()) {
    try {
      const result = await check.run(ctx);
      if (!result) continue;
      problems.push({ title: check.title, text: result.text, details: result.fix });
      if (result.severity === "error") blocked = true;
    } catch (e) {
      // A broken check must not break the commit: report it and let Commit Anyway go on.
      problems.push({ title: check.title, text: tx`The check could not run: ${failureText(e)}` });
      blocked = true;
    }
  }
  return { problems, blocked };
}
