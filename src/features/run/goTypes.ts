import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { parseArgs } from "./configs";

const scopes = ["Directory", "File", "Package"].map((label) => ({ value: label.toLowerCase(), label }));
const fields: RunConfigTypeContribution["fields"] = [
  {
    key: "goKind",
    label: "Go configuration",
    control: "select",
    options: [
      { value: "build", label: "Go Build" },
      { value: "test", label: "Go Test" },
    ],
  },
  { key: "scope", label: "Run kind", control: "select", options: scopes },
  {
    key: "target",
    label: "Target",
    mono: true,
    required: true,
    validate: (value, p) =>
      p.goKind === "test" && p.scope === "file" && value.includes("|") ? "Select one Go test file" : null,
  },
  { key: "outputDir", label: "Output directory", mono: true, visible: (p) => p.goKind !== "test" },
  { key: "runAfterBuild", label: "Run after build", control: "checkbox", visible: (p) => p.goKind !== "test" },
  { key: "pattern", label: "Pattern", mono: true, visible: (p) => p.goKind === "test" },
  { key: "toolArgs", label: "Go tool arguments", mono: true },
  { key: "useTags", label: "Use all custom build tags", control: "checkbox" },
  { key: "programArgs", label: "Program arguments", mono: true },
  {
    key: "module",
    label: "Module",
    mono: true,
    placeholder: "Project root",
    suggestions: (configs) => [
      ...new Set(configs.filter((c) => c.kind === "go").map((c) => c.params?.module ?? c.cwd ?? "")),
    ],
  },
];

function commandLine(p: Record<string, string>) {
  const test = p.goKind === "test";
  const tool = parseArgs(p.toolArgs ?? "");
  const target = p.target?.trim() || ".";
  const targets =
    p.scope === "file"
      ? target
          .split("|")
          .map((f) => f.trim())
          .filter(Boolean)
      : [target];
  return {
    command: p.executable || "go",
    args: test
      ? [
          "test",
          ...tool,
          ...(p.pattern ? ["-run", p.pattern] : []),
          ...targets,
          ...(p.programArgs?.trim() ? ["-args", ...parseArgs(p.programArgs)] : []),
        ]
      : ["build", ...tool, ...targets],
  };
}

function paramsFrom(c: RunConfig): Record<string, string> | null {
  const [op, ...args] = c.args;
  // Old arbitrary command lines remain available in the shared command form.
  if (!["run", "build", "test"].includes(op ?? "") || args.length !== 1 || args[0]!.startsWith("-")) return null;
  return {
    goKind: op === "test" ? "test" : "build",
    scope: "package",
    target: args[0]!,
    runAfterBuild: op === "run" ? "true" : "false",
    module: c.cwd ?? "",
    executable: c.command,
  };
}

export const goBuildType: RunConfigTypeContribution = {
  id: "go",
  label: "Go Build",
  icon: "file-go",
  description: "Build and run a Go application",
  defaults: { goKind: "build", scope: "package", target: ".", runAfterBuild: "true", useTags: "true" },
  debugAdapter: "delve",
  terminal: false,
  fields,
  commandLine,
  paramsFrom,
};
export const goTestType: RunConfigTypeContribution = {
  ...goBuildType,
  id: "go-test",
  label: "Go Test",
  description: "Run Go tests",
  defaults: { goKind: "test", scope: "package", target: ".", useTags: "true" },
};
