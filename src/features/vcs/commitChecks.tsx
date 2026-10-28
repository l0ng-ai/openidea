/**
 * Commit checks (Settings › Version Control › Commit / Git): before-commit
 * modifications (Reformat code, Optimize imports, Cleanup) applied through
 * the language servers, then the checks (Analyze code, Check TODO) and the Git
 * warnings (detached HEAD / rebase, file names, large files, CRLF line separators).
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
import { currentRepo, useVcs } from "./store";
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

// ---------------------------------------------------------------------------
// Problems

/**
 * A failed before-commit check, shown in the commit panel (as IDEA)
 * while the Commit button turns into "Commit Anyway".
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

export interface CommitCandidate {
  /** Absolute path. */
  path: string;
  /** False for deletions. */
  exists: boolean;
}

/**
 * Runs the configured before-commit modifications and checks for the files about to
 * be committed. Resolves the problems found; the commit goes ahead only without any.
 */
export async function runCommitChecks(files: readonly CommitCandidate[], amend: boolean): Promise<CommitProblem[]> {
  const { commit, git } = workflowSettings().vcs;
  const branch = useVcs.getState().branch;
  const problems: CommitProblem[] = [];

  if (git.warnDetachedHead && branch && (!branch.head || branch.operation === "rebase")) {
    const rebase = branch.operation === "rebase";
    problems.push({
      title: rebase ? "Commit during rebase" : "Commit in detached HEAD",
      text: rebase
        ? "A rebase is in progress. The commit will become part of the rebased history; usually you continue the rebase instead."
        : "HEAD is detached: the commit won't belong to any branch and may be lost after checking out another branch. Create a branch first to keep it.",
    });
  }

  const existing = files.filter((f) => f.exists).map((f) => f.path);
  if (git.warnBadFileNames) {
    // New paths only: a name already in the repository is not this commit's problem.
    const kinds = new Map(useVcs.getState().status.map((f) => [stripSlash(f.path), effectiveKind(f)]));
    const added = existing.filter((p) => ["added", "untracked", "renamed"].includes(kinds.get(p) ?? ""));
    const bad = badFileName(added, useVcs.getState().root ?? "");
    if (bad)
      problems.push({
        title: "File names",
        text:
          bad.kind === "reserved"
            ? tx`Some files use reserved names that are not allowed on Windows: '${bad.name}'. If you commit, it will not be possible to check out the Git repository on Windows.`
            : tx`Some of the file names contain characters that are not allowed on Windows: '${bad.name}'. If you commit, it might not be possible to check out the Git repository on Windows.`,
      });
  }
  if (!isTauri() || !existing.length) return problems;

  if (git.warnLargeFiles) {
    const large = await largeFiles(existing, git.largeFileMb * 1024 * 1024);
    if (large.length) {
      const mb = Math.ceil(large.reduce((n, f) => n + f.size, 0) / (1024 * 1024));
      problems.push({
        title: "Large files",
        text:
          large.length === 1
            ? tx`You are about to commit a large file into the repository: ${baseName(large[0]!.path)} (${mb} MB). It is not recommended to store large files in a Git repository. Consider using Git LFS.`
            : tx`You are about to commit ${large.length} large files into the repository with the total size of ${mb} MB. It is not recommended to store large files in a Git repository. Consider using Git LFS.`,
      });
    }
  }

  const mods: Modifications = {
    reformat: commit.reformat,
    optimizeImports: commit.optimizeImports,
    cleanup: commit.cleanup,
  };
  if (mods.reformat || mods.optimizeImports || mods.cleanup) {
    logConsole(
      "info",
      `Before commit: ${[mods.optimizeImports && "optimize imports", mods.cleanup && "cleanup", mods.reformat && "reformat code"].filter(Boolean).join(", ")}`,
    );
    for (const p of existing) await modifyFile(p, mods);
    try {
      await maybeEditorService()?.saveAll();
    } catch {
      // best effort
    }
  }

  if (commit.analyzeCode) {
    // Opening the files makes their language servers analyse them.
    const opened: number[] = [];
    for (const p of existing.filter((p) => !analyzed.has(p))) {
      try {
        opened.push((await call(commands.docOpen(p))).id);
      } catch {
        // binary / unreadable
      }
    }
    try {
      await waitForAnalysis(existing, opened.length ? 2000 : 0);
    } finally {
      opened.forEach((id) => void commands.docClose(id));
    }
    const { errors, warnings, files: n } = problemCounts(existing);
    if (errors + warnings > 0) {
      const errorCount = errors === 1 ? tx`${errors} error` : tx`${errors} errors`;
      const warningCount = warnings === 1 ? tx`${warnings} warning` : tx`${warnings} warnings`;
      const found = !warnings ? errorCount : !errors ? warningCount : tx`${errorCount} and ${warningCount}`;
      problems.push({
        title: "Code analysis",
        text: n === 1 ? tx`${found} found in ${n} file` : tx`${found} found in ${n} files`,
        details: {
          label: "Review",
          run: () => {
            try {
              toolWindowService().show("problems", true);
            } catch {
              // no Problems tool window
            }
          },
        },
      });
    }
  }

  if (commit.checkTodo) {
    const root = useVcs.getState().root ?? "";
    const hits: TodoHit[] = [];
    for (const p of existing) {
      try {
        const [oldText, newText] = await Promise.all([
          call(commands.vcsFileAt(p, amend ? "HEAD~1" : "HEAD")).catch(() => null),
          call(commands.fsReadText(p)),
        ]);
        hits.push(...(await todosInChanges(p, oldText ?? "", newText)));
      } catch {
        // unreadable / binary
      }
    }
    if (hits.length) {
      problems.push({
        title: "TODO",
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
                    {relTo(root, h.path)}:{h.line + 1}
                  </button>{" "}
                  {h.text}
                </li>
              ))}
              {hits.length > 20 && <li>…</li>}
            </ul>
          </>
        ),
      });
    }
  }

  if (git.warnCrlf) {
    const autocrlf = (
      await call(commands.vcsConfigGet(currentRepo(), "core.autocrlf")).catch(() => null)
    )?.toLowerCase();
    if (autocrlf !== "true" && autocrlf !== "input") {
      const crlf: string[] = [];
      for (const p of existing) {
        try {
          if ((await call(commands.fsReadText(p))).includes("\r\n")) crlf.push(p);
        } catch {
          // skip
        }
      }
      if (crlf.length) {
        const crlfNames = crlf.slice(0, 5).map(baseName).join(", ") + (crlf.length > 5 ? ", …" : "");
        problems.push({
          title: "Line separators",
          text: (
            <>
              {crlf.length === 1
                ? tx`${crlf.length} file (${crlfNames}) contain CRLF line separators and core.autocrlf is not set, so they would be committed with CRLF. Convert them with the line separator widget in the status bar, or set`
                : tx`${crlf.length} files (${crlfNames}) contain CRLF line separators and core.autocrlf is not set, so they would be committed with CRLF. Convert them with the line separator widget in the status bar, or set`}{" "}
              <code>git config core.autocrlf input</code>.
            </>
          ),
        });
      }
    }
  }
  return problems;
}
