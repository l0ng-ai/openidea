import { lazyComponent } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";

export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: "vcs.github",
    title: "GitHub",
    order: 9,
    keywords: ["pull request", "viewed", "review", "account", "gh", "token"],
    component: lazyComponent(() => import("./diff/GithubSettingsPage").then((m) => m.GithubSettingsPage)),
  });
}
