/**
 * Git repositories below the open project that it does not manage yet (IDEA's
 * unregistered VCS roots). Discovery is automatic here, so the notification reports
 * what the background scan missed and its action reruns that scan; no root list is
 * stored.
 */
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, type NotificationService } from "@/workbench/contributions";

/** One notification per project: a later check replaces it. */
export const UNREGISTERED_ROOTS_KEY = "vcs.unregisteredRoots";
/** The scan on project open runs in the background; check once it has had time to finish. */
const OPEN_DELAY_MS = 1500;
/** After a VCS refresh the project's repositories are up to date. */
const VCS_DELAY_MS = 300;
/**
 * A repository the watcher does not see triggers no event, so the check polls: often just after
 * the project opens (a folder moved in right then has no `.git` event), rarely afterwards, since
 * every check walks the project.
 */
const EARLY_POLL_MS = 30_000;
const EARLY_POLLS = 4;
const LATE_POLL_MS = 300_000;
/** Paths listed in the balloon; the rest become `+N more`. */
const LISTED = 3;

export type UnregisteredRootsNotice = Parameters<NotificationService["notify"]>[0];

/** `path` relative to `root`, as the Project view shows it, else as given. */
export function projectRelative(root: string | null, path: string): string {
  if (!root) return path;
  const base = root.replace(/\/+$/, "");
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** The notification body: up to three paths, then `+N more`. */
export function unregisteredRootsBody(paths: readonly string[], root: string | null): string {
  const shown = paths
    .slice(0, LISTED)
    .map((path) => projectRelative(root, path))
    .join(", ");
  const count = paths.length - LISTED;
  return count > 0 ? tx`${shown} +${count} more` : shown;
}

/** The sticky notification offering to add `paths`; the action reruns the project's scan. */
export function unregisteredRootsNotice(paths: readonly string[], root: string | null): UnregisteredRootsNotice {
  return {
    group: "vcs",
    level: "info",
    key: UNREGISTERED_ROOTS_KEY,
    title: tx("Unregistered Git repositories"),
    body: unregisteredRootsBody(paths, root),
    sticky: true,
    actions: [{ label: tx("Add to Project"), run: () => void addUnregisteredRoots() }],
  };
}

async function addUnregisteredRoots(): Promise<void> {
  try {
    await call(commands.vcsRefreshRoots());
    // Some roots may stay out (skipped names, a scan that still lags): let the caller re-check.
    notifications().expire?.(UNREGISTERED_ROOTS_KEY);
  } catch {
    /* the next scan registers them */
  }
}

/**
 * Reports unregistered repositories while a project is open: on open, after VCS refreshes, and on
 * a poll that is frequent just after the project opens and rare afterwards (every check walks the
 * project). Returns a disposer.
 */
export function installUnregisteredRoots(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  /** How many polls the project has had; the first few are the frequent ones. */
  let polls = 0;
  /** The paths the current notification lists; empty when none is shown. */
  let shown = "";

  const check = async () => {
    const project = useProject.getState().project;
    if (!project || !isTauri()) return;
    const paths = await call(commands.vcsUnregisteredRoots()).catch(() => null);
    // A project switch (or no backend support yet) leaves the new project to its own check.
    if (!paths || useProject.getState().project !== project) return;
    if (!paths.length) {
      if (shown) notifications().expire?.(UNREGISTERED_ROOTS_KEY);
      shown = "";
      return;
    }
    const found = paths.join("\n");
    if (found === shown) return;
    shown = found;
    notifications().notify(unregisteredRootsNotice(paths, project.root));
  };

  const checkSoon = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void check(), delay);
  };
  const pollNext = () => {
    poll = setTimeout(
      () => {
        polls += 1;
        void check();
        pollNext();
      },
      polls < EARLY_POLLS ? EARLY_POLL_MS : LATE_POLL_MS,
    );
  };

  checkSoon(OPEN_DELAY_MS);
  pollNext();
  const unsubProject = useProject.subscribe((state, previous) => {
    if (state.project !== previous.project) {
      shown = "";
      polls = 0;
      checkSoon(OPEN_DELAY_MS);
    }
  });
  const offVcs = onIdeEvent("vcsChanged", () => checkSoon(VCS_DELAY_MS));
  return () => {
    clearTimeout(timer);
    clearTimeout(poll);
    unsubProject();
    offVcs();
  };
}
