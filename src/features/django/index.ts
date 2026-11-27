/** Django: Run manage.py Task. */
import { executeAction, registerActions } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, registerRunAnythingProvider } from "@/workbench/contributions";
import { loadManage, manageRunAnything, resetManage, useManage } from "./manage";

const run = (config: RunConfig) => executeAction("run.runConfig", config);

export function activate(): () => void {
  const disposers = [
    registerRunAnythingProvider(manageRunAnything(run)),
    registerActions([
      {
        id: "django.runManageTask",
        title: "Run manage.py Task…",
        category: "Tools",
        keywords: ["django", "manage.py", "migrate", "makemigrations"],
        when: "projectOpen",
        run: async () => {
          await loadManage();
          if (!useManage.getState().manage) {
            notifications().notify({ level: "info", title: "No manage.py in this project" });
            return;
          }
          await executeAction("runAnything.show", "manage.py ");
        },
      },
    ]),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetManage();
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
