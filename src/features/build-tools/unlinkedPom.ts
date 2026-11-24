import { registerActions } from "@/platform/actions";
import { registerEditorBanner, registerMenuGroup, type EditorBanner } from "@/workbench/contributions";
import { addPomAsProject, skipPom, suggestsLoadingPom, unlinkedPom, useBuild } from "./store";

/** The model is only loaded for a trusted project, so an untrusted one never shows this. */
function useUnlinkedPomBanner(path: string): EditorBanner | null {
  const pom = useBuild((s) => (s.model && !s.loading ? unlinkedPom(path) : null));
  const skipped = useBuild((s) => s.settings.skippedPoms);
  if (!pom || !suggestsLoadingPom(pom, skipped)) return null;
  return {
    text: "This Maven project is not loaded",
    actions: [
      { label: "Load Maven Project", run: () => void addPomAsProject(path) },
      { label: "Skip", run: () => skipPom(pom) },
    ],
  };
}

/** Add as Maven Project (project view) and the banner above an unlinked `pom.xml`. */
export function registerUnlinkedPom(): () => void {
  const disposers = [
    registerEditorBanner({ id: "maven.unlinkedPom", order: 20, useBanner: useUnlinkedPomBanner }),
    registerActions([
      {
        id: "maven.addFileAsProject",
        title: "Add as Maven Project",
        category: "Maven",
        icon: "plus",
        hidden: true,
        when: "projectOpen && !workspaceOpen",
        run: async ({ arg }) => {
          const path = (arg as { path?: unknown } | undefined)?.path;
          if (typeof path === "string") await addPomAsProject(path);
        },
      },
    ]),
    registerMenuGroup({
      id: "maven.addFileAsProject",
      menus: ["projectView"],
      order: 30,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (!path || !unlinkedPom(path)) return [];
        return [{ kind: "action", action: "maven.addFileAsProject", arg: { path }, label: "Add as Maven Project" }];
      },
    }),
  ];
  return () => disposers.forEach((d) => d());
}
