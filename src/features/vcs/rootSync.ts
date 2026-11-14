import type { BranchInfo } from "@/bindings";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { setFileDecorations, type DecorationSegment, type FileDecoration } from "@/workbench/contributions";
import { useVcs } from "./store";

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

export function rootSyncSuffix(info: BranchInfo): DecorationSegment[] | null {
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
  if (!upstream) return [branch];
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
  return [branch, styled("head-tags", { text: "/", color: "var(--git-head-tags, var(--accent))" }), ...counts];
}

async function branchInfoOf(root: string): Promise<[string, BranchInfo] | null> {
  try {
    return [root, await call(commands.vcsBranchInfo(root))];
  } catch {
    return null;
  }
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

  const publish = (next: ReadonlyMap<string, FileDecoration>) => {
    if (disposed || sameDecorations(next, shown)) return;
    shown = next;
    setFileDecorations(PROVIDER, new Map(next));
  };

  const update = async () => {
    const { available, roots } = useVcs.getState();
    if (!available || !workflowSettings().vcs.git.showBranchInProjectView) return publish(new Map());
    const infos = await Promise.all(roots.map(branchInfoOf));
    const next = new Map<string, FileDecoration>();
    roots.forEach((root, i) => {
      const entry = infos[i];
      const suffix = entry ? rootSyncSuffix(entry[1]) : shown.get(root)?.suffix;
      if (suffix) next.set(root, { suffix, suffixColor: SUFFIX_COLOR });
    });
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
    if (s.available !== prev.available || s.roots.join("\n") !== prev.roots.join("\n")) schedule();
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
