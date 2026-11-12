/** Welcome screen, recent projects (File › Open Recent) and reopening the last project on startup. */
import { registerActions } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { loadRecent } from "./recent";
import { lazyComponent } from "@/ui";
import { provideProjectPopup, provideWelcomeView, registerOverlay } from "@/workbench/contributions";
import { RecentProjectsPopup, showRecentProjectsPopup } from "./RecentProjectsPopup";
import { reopenLastProject, trackSession } from "./session";
import { WelcomeView } from "./WelcomeView";

export function activate(): () => void {
  const disposers = [
    trackSession(),
    onIdeEvent("windowGroupsChanged", () => void loadRecent()),
    provideWelcomeView(WelcomeView),
    provideProjectPopup(lazyComponent(() => import("./ProjectPopup").then((m) => m.ProjectPopup))),
    registerOverlay({ id: "welcome.recentProjects", component: RecentProjectsPopup }),
    registerActions([
      {
        id: "welcome.recentProjects",
        title: "Recent Projects…",
        category: "File",
        icon: "history",
        keywords: ["open recent", "projects"],
        run: showRecentProjectsPopup,
      },
      {
        id: "file.openRecent",
        title: "Open Recent…",
        category: "File",
        icon: "history",
        keywords: ["recent projects", "reopen"],
        run: showRecentProjectsPopup,
      },
    ]),
  ];
  void reopenLastProject();
  return () => disposers.reverse().forEach((d) => d());
}
