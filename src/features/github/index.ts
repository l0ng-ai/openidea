/**
 * GitHub pull requests through the gh CLI: the Pull Requests tool window (list,
 * details, files diffed in the diff viewer with review comments, commits,
 * conversation), checkout, create, review and comment.
 */
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { GithubDialogHost } from "./dialogs";
import { checkoutAction, createPullRequest, openInBrowser, showPullRequests, WINDOW } from "./ops";
import { PullRequestsHeader, PullRequestsView } from "./PullRequestsView";
import { refreshAll, resetGithub } from "./store";

const WHEN = "projectOpen";

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: WINDOW,
      title: "Pull Requests",
      icon: "toolwindow-pull-requests",
      anchor: "left",
      order: 2,
      stripe: "onUse",
      component: PullRequestsView,
      headerContent: PullRequestsHeader,
    }),
    registerOverlay({ id: "github.dialogs", component: GithubDialogHost }),
    registerActions([
      {
        id: "github.pullRequests",
        title: "View Pull Requests",
        category: "GitHub",
        icon: "toolwindow-pull-requests",
        keywords: ["github", "pr", "review"],
        when: WHEN,
        run: () => showPullRequests(),
      },
      {
        id: "github.createPullRequest",
        title: "Create Pull Request…",
        category: "GitHub",
        icon: "plus",
        keywords: ["github", "pr"],
        when: WHEN,
        run: () => createPullRequest(),
      },
      {
        id: "github.checkoutPullRequest",
        title: "Checkout Pull Request…",
        description: "Checks out the selected pull request, a number given as argument, or asks for one.",
        category: "GitHub",
        icon: "branch",
        keywords: ["github", "pr"],
        when: WHEN,
        run: ({ arg }) => checkoutAction(arg),
      },
      {
        id: "github.openInBrowser",
        title: "Open on GitHub",
        category: "GitHub",
        icon: "external-link",
        when: WHEN,
        run: () => openInBrowser(),
      },
      {
        id: "github.refresh",
        title: "Refresh Pull Requests",
        category: "GitHub",
        icon: "refresh",
        when: WHEN,
        run: () => refreshAll(),
      },
    ]),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetGithub(s.project?.root ?? null);
    }),
  ];
  resetGithub(useProject.getState().project?.root ?? null);
  return () => disposers.reverse().forEach((d) => d());
}
