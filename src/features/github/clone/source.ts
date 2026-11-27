import { lazyComponent } from "@/ui";
import type { CloneSourceContribution } from "@/workbench/contributions";

/** Get from VCS › GitHub: the signed-in accounts' repositories. */
export const githubCloneSource: CloneSourceContribution = {
  id: "github",
  label: "GitHub",
  icon: "github",
  order: 10,
  component: lazyComponent(() => import("./GitHubCloneSource").then((m) => m.GitHubCloneSource)),
};
