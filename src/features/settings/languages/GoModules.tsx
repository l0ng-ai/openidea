import { useProject } from "@/platform/project";
import { T } from "@/ui";
import { useSettingsDialog } from "../model/staging";
import { PageContext } from "../components/context";
import { OptionsPage } from "../pages/OptionsPage";
import type { SectionSpec } from "../pages/spec";

export const GO_MODULE_SECTIONS: SectionSpec[] = [
  {
    options: [
      { kind: "toggle", key: "languages.go.modules.autoVendor", label: "Enable vendoring support automatically" },
      ...[
        "GOPROXY",
        "GOPRIVATE",
        "GOFLAGS",
        "GONOPROXY",
        "GONOSUMDB",
        "GOSUMDB",
        "GOMODCACHE",
        "GOTOOLCHAIN",
        "GOWORK",
      ].map((name) => ({
        kind: "text" as const,
        key: `languages.go.modules.env.${name}`,
        label: name,
        placeholder: "Inherit from environment",
      })),
    ],
  },
];

export function GoModulesPage() {
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  if (!hasProject || newProjects) return <T>Open a project to configure Go modules.</T>;
  return (
    <PageContext.Provider value={{ pageId: "languages.go.modules", scope: "project" }}>
      <OptionsPage spec={{ id: "languages.go.modules", title: "Go Modules", order: 0, sections: GO_MODULE_SECTIONS }} />
    </PageContext.Provider>
  );
}
