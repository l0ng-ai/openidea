/** Django: Run manage.py Task, URL names in reverse() calls. */
import { registerEditorContribution, registerNavigationProvider } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { executeAction, registerActions } from "@/platform/actions";
import { onIdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, registerRunAnythingProvider } from "@/workbench/contributions";
import { loadManage, manageRunAnything, resetManage, useManage } from "./manage";
import { forgetUrlNames, urlCompletionExtension, urlNavigation } from "./urls";

const isUrls = (path: string) => path.endsWith("/urls.py");

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
    registerNavigationProvider(async (view, offset) => {
      const doc = docOf(view);
      if (!doc || doc.virtual || doc.language !== "python") return null;
      const line = view.state.doc.lineAt(offset);
      return urlNavigation(line.text, line.from, offset);
    }),
    registerEditorContribution({ id: "django.urlNames", extensions: urlCompletionExtension }),
    onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some(isUrls)) forgetUrlNames();
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      resetManage();
      forgetUrlNames();
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
