import { useProject } from "@/platform/project";
import { T } from "@/ui";
import { useSettingsDialog } from "../model/staging";
import { PageContext } from "../components/context";
import { OptionsPage } from "../pages/OptionsPage";
import type { SectionSpec } from "../pages/spec";

const choices = (values: string[]) => [
  { value: "", label: "Automatic" },
  ...values.map((value) => ({ value, label: value })),
];
const key = (name: string) => `languages.go.buildTags.${name}`;
export const GO_BUILD_TAG_SECTIONS: SectionSpec[] = [
  {
    options: [
      {
        kind: "select",
        key: key("os"),
        label: "Operating System",
        options: choices([
          "aix",
          "android",
          "darwin",
          "dragonfly",
          "freebsd",
          "illumos",
          "ios",
          "js",
          "linux",
          "netbsd",
          "openbsd",
          "plan9",
          "solaris",
          "wasip1",
          "windows",
        ]),
      },
      {
        kind: "select",
        key: key("arch"),
        label: "Architecture",
        options: choices([
          "386",
          "amd64",
          "arm",
          "arm64",
          "loong64",
          "mips",
          "mipsle",
          "mips64",
          "mips64le",
          "ppc64",
          "ppc64le",
          "riscv64",
          "s390x",
          "wasm",
        ]),
      },
      { kind: "text", key: key("version"), label: "Go Version", placeholder: "go1.22" },
      { kind: "select", key: key("compiler"), label: "Compiler", options: choices(["gc", "gccgo"]) },
      {
        kind: "select",
        key: key("cgo"),
        label: "CGO",
        options: [
          { value: "", label: "Automatic" },
          { value: "1", label: "Enabled" },
          { value: "0", label: "Disabled" },
        ],
      },
      { kind: "text", key: key("custom"), label: "Custom Tags", placeholder: "integration debug" },
      { kind: "text", key: key("experiments"), label: "Experiments", placeholder: "loopvar,rangefunc" },
    ],
  },
];

export function GoBuildTagsPage() {
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  if (!hasProject || newProjects) return <T>Open a project to configure Go build tags.</T>;
  return (
    <PageContext.Provider value={{ pageId: "languages.go.buildTags", scope: "project" }}>
      <OptionsPage
        spec={{ id: "languages.go.buildTags", title: "Build Tags", order: 0, sections: GO_BUILD_TAG_SECTIONS }}
      />
    </PageContext.Provider>
  );
}
