/**
 * The quick Create Pull Request flow through `gh pr create` (push first when needed), with
 * the dialog in `ui/dialogs.tsx`. The New Pull Request tab offers it until its form is
 * ported.
 */
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { reloadList } from "../data/list";
import { openInBrowser, withBusy } from "../data/local";
import { requireConnection } from "../data/repository";
import { createPullRequestDialog } from "../ui/dialogs";
import { openPullRequest } from "./open";

/** Asks for the details and creates a pull request from the current branch; whether one was created. */
export async function createPullRequestWithDialog(): Promise<boolean> {
  const { repository } = requireConnection();
  const defaultBranch = repository.defaultBranchRef?.name ?? null;
  let head: string | null = null;
  let needsPush = true;
  let title = "";
  try {
    const info = await call(commands.vcsBranchInfo(null));
    head = info.head;
    needsPush = !info.upstream || info.ahead > 0;
    if (head)
      title = head
        .replace(/^[^/]+\//, "")
        .replace(/[-_]+/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());
  } catch {
    // Not a git repository: gh will explain.
  }
  if (!head) {
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: "Check out a branch to create a pull request from",
      key: "github-create",
    });
    return false;
  }
  if (head === defaultBranch) {
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: `'${head}' is the default branch`,
      body: "Create a branch for your changes first.",
      key: "github-create",
      actions: [{ label: "New Branch…", run: () => void executeAction("vcs.newBranch") }],
    });
    return false;
  }
  const input = await createPullRequestDialog({ head, defaultBase: defaultBranch, title, needsPush });
  if (!input) return false;
  const url = await withBusy(`Creating pull request…`, (r, out) => call(commands.ghPrCreate(r, input, out)));
  if (url === null) return false;
  notifications().notify({
    group: "vcs",
    level: "info",
    title: "Pull request created",
    body: url || undefined,
    key: "github-create",
    actions: url ? [{ label: "Open in Browser", run: () => void openInBrowser(url) }] : undefined,
  });
  void reloadList();
  const m = /\/pull\/(\d+)/.exec(url);
  if (m) await openPullRequest(Number(m[1]));
  return true;
}
