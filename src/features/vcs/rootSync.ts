import type { BranchInfo, FileStatus } from "@/bindings";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { setFileDecorations, type DecorationSegment, type FileDecoration } from "@/workbench/contributions";
import { rootOf } from "./model";
import { useVcs, type RepoHead } from "./store";

const PROVIDER = "vcs-root-sync";
const GIT_CHANGE_DELAY_MS = 250;
const SUFFIX_COLOR = "var(--git-local-branch, var(--accent))";

/** Whether a branch name is a default branch (master/main get their own colours). */
const defaultBranch = (name: string) => name === "master" || name === "main";

/** Font style / effect a scheme override puts on one Git attribute, e.g. bold tracking branches. */
const styled = (attr: string, extra: Pick<DecorationSegment, "text"> & DecorationSegment): DecorationSegment => ({
  fontWeight: `var(--git-${attr}-bold, inherit)`,
  fontStyle: `var(--git-${attr}-italic, inherit)`,
  textDecoration: `var(--git-${attr}-effect, none)`,
  ...extra,
});

/** How many files of the working tree changed (staged, unstaged or untracked): nothing when clean. */
function changedFiles(count: number): DecorationSegment[] {
  if (count <= 0) return [];
  return [{ text: String(count), icon: "edit", label: tx`${count} changed files`, color: "var(--vcs-modified)" }];
}

export function rootSyncSuffix(info: BranchInfo, changed = 0): DecorationSegment[] | null {
  const { head, upstream, ahead, behind } = info;
  if (!head) return null;
  const branchAttr = upstream
    ? defaultBranch(head)
      ? "master-with-remote"
      : "tracking-branch"
    : defaultBranch(head)
      ? "master-without-remote"
      : "local-branch";
  const branchColor = `var(--git-${branchAttr}, var(--accent))`;
  const branch: DecorationSegment = styled(branchAttr, { text: head, color: branchColor });
  if (!upstream) return [branch, ...changedFiles(changed)];
  const counts: DecorationSegment[] = [];
  if (ahead > 0)
    counts.push(
      styled("branch-changed", {
        text: String(ahead),
        icon: "vcs-outgoing",
        label: tx`${ahead} outgoing commits`,
        color: "var(--git-branch-changed, var(--accent))",
      }),
    );
  if (behind > 0)
    counts.push(
      styled("branch-changed", {
        text: String(behind),
        icon: "vcs-incoming",
        label: tx`${behind} incoming commits`,
        color: "var(--git-branch-changed, var(--accent))",
      }),
    );
  if (!counts.length)
    counts.push(
      styled("head-tags", {
        text: "0",
        strike: true,
        label: tx`Up to date with ${upstream}`,
        color: "var(--git-head-tags, var(--accent))",
      }),
    );
  return [
    branch,
    styled("head-tags", { text: "/", color: "var(--git-head-tags, var(--accent))" }),
    ...counts,
    ...changedFiles(changed),
  ];
}

/** Changed files per repository root (each file counted once, in its innermost repository). */
export function changedByRoot(status: readonly FileStatus[], roots: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of status) {
    if (f.staged === "ignored" || f.unstaged === "ignored") continue;
    const root = rootOf(f.path, roots);
    if (root) out.set(root, (out.get(root) ?? 0) + 1);
  }
  return out;
}

async function branchInfoOf(root: string): Promise<[string, BranchInfo] | null> {
  try {
    return [root, await call(commands.vcsBranchInfo(root))];
  } catch {
    return null;
  }
}

/** Whether a repository's branch or HEAD commit differs between two refreshes. */
export function headsMoved(a: Readonly<Record<string, RepoHead>>, b: Readonly<Record<string, RepoHead>>): boolean {
  if (a === b) return false;
  const roots = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const root of roots) {
    const x = a[root];
    const y = b[root];
    if (x?.head !== y?.head || x?.headCommit !== y?.headCommit) return true;
  }
  return false;
}

function sameDecorations(a: ReadonlyMap<string, FileDecoration>, b: ReadonlyMap<string, FileDecoration>): boolean {
  if (a.size !== b.size) return false;
  for (const [root, d] of a) if (JSON.stringify(d) !== JSON.stringify(b.get(root))) return false;
  return true;
}

export function installRootSync(): () => void {
  let disposed = false;
  let running = false;
  let pending = false;
  let shown: ReadonlyMap<string, FileDecoration> = new Map();
  let branches = new Map<string, BranchInfo>();

  const publish = (next: ReadonlyMap<string, FileDecoration>) => {
    if (disposed || sameDecorations(next, shown)) return;
    shown = next;
    setFileDecorations(PROVIDER, new Map(next));
  };

  const update = async () => {
    const { available, roots } = useVcs.getState();
    if (!available || !workflowSettings().vcs.git.showBranchInProjectView) return publish(new Map());
    const infos = await Promise.all(roots.map(branchInfoOf));
    const next = new Map<string, BranchInfo>();
    roots.forEach((root, i) => {
      // A repository whose branch can't be read now keeps what it showed.
      const info = infos[i]?.[1] ?? branches.get(root);
      if (info) next.set(root, info);
    });
    branches = next;
    render();
  };

  /** The suffixes from the branches last read and the current working tree status (no git query). */
  const render = () => {
    const { available, roots, status } = useVcs.getState();
    if (!available || !workflowSettings().vcs.git.showBranchInProjectView) return publish(new Map());
    const changed = changedByRoot(status, roots);
    const next = new Map<string, FileDecoration>();
    for (const root of roots) {
      const info = branches.get(root);
      const suffix = info ? rootSyncSuffix(info, changed.get(root) ?? 0) : null;
      if (suffix) next.set(root, { suffix, suffixColor: SUFFIX_COLOR });
    }
    publish(next);
  };

  const schedule = () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          pending = false;
          await update();
        } while (pending && !disposed);
      } finally {
        running = false;
      }
    })();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(schedule, GIT_CHANGE_DELAY_MS);
  };

  const unsubVcs = useVcs.subscribe((s, prev) => {
    if (
      s.available !== prev.available ||
      s.roots.join("\n") !== prev.roots.join("\n") ||
      // A commit, checkout or update moved a HEAD; a fetch or push finished.
      headsMoved(s.heads, prev.heads) ||
      (prev.remoteBusy && !s.remoteBusy)
    )
      schedule();
    // The changed-file counts follow the working tree as the status refreshes, without asking git.
    else if (s.status !== prev.status) render();
  });
  const offGit = onIdeEvent("vcsChanged", scheduleSoon);
  const offSettings = onWorkflowSettingsChange((s) => s.vcs.git.showBranchInProjectView, schedule);
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    unsubVcs();
    offGit();
    offSettings();
    setFileDecorations(PROVIDER, new Map());
  };
}
