/** Django: Run manage.py Task, URL names in reverse() calls, field lookups and type stubs. */
import { registerEditorContribution, registerNavigationProvider } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { executeAction, registerActions } from "@/platform/actions";
import { onIdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, registerEditorBanner, registerRunAnythingProvider } from "@/workbench/contributions";
import { loadManage, locateManage, manageRunAnything, resetManage, useManage } from "./manage";
import { forgetModels, lookupCompletionExtension } from "./models";
import { checkStubs, resetStubs, useStubsBanner } from "./stubs";
import { forgetUrlNames, urlCompletionExtension, urlNavigation } from "./urls";

const isUrls = (path: string) => path.endsWith("/urls.py");
const isModels = (path: string) => path.endsWith("/models.py");

/** A Django project's interpreter without type stubs gets the banner. */
async function checkProject() {
  const { manage, python } = await locateManage().catch(() => ({ manage: null, python: null }));
  if (manage && python) await checkStubs(python);
}

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
    registerEditorContribution({ id: "django.lookups", extensions: lookupCompletionExtension }),
    registerEditorBanner({ id: "django.stubs", order: 12, useBanner: useStubsBanner }),
    onIdeEvent("fsChanged", (e) => {
      const changed = [...e.created, ...e.modified, ...e.removed];
      if (changed.some(isUrls)) forgetUrlNames();
      if (changed.some(isModels)) forgetModels();
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      resetManage();
      forgetUrlNames();
      forgetModels();
      resetStubs();
      if (s.project) void checkProject();
    }),
  ];
  if (useProject.getState().project) void checkProject();
  return () => disposers.reverse().forEach((d) => d());
}
