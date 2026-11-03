import { call, commands, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { parseArgs } from "./configs";

function profile(p: Readonly<Record<string, string>>): {
  applicationUrl?: string;
  environmentVariables?: Record<string, string>;
} {
  try {
    return JSON.parse(p.profiles || "{}")[p.launchProfile || ""] ?? {};
  } catch {
    return {};
  }
}

export function dotnetCommand(p: Readonly<Record<string, string>>, test = false) {
  return {
    command: p.executable || "dotnet",
    args: [
      ...(test ? ["test", p.project || ""] : ["run", "--project", p.project || ""]),
      ...(p.framework ? ["--framework", p.framework] : []),
      ...(!test ? (p.launchProfile ? ["--launch-profile", p.launchProfile] : ["--no-launch-profile"]) : []),
      ...(p.programArgs?.trim() ? ["--", ...parseArgs(p.programArgs)] : []),
    ],
  };
}

/** Build the current project/framework, independently of the run's profile working directory. */
export function dotnetBuildConfig(config: RunConfig): RunConfig {
  const p = config.params ?? {};
  return {
    ...config,
    id: `dotnet-build:${config.id}`,
    name: `dotnet build (${p.project || ""})`,
    kind: "shell",
    args: ["build", p.project || "", "--configuration", "Debug", ...(p.framework ? ["--framework", p.framework] : [])],
    cwd: useProject.getState().project?.root ?? null,
    env: {},
    params: {},
    isTest: false,
    debugAdapter: null,
    beforeLaunch: [],
    emulateTerminal: false,
    stdinFile: undefined,
  };
}

export const dotnetProjectType: RunConfigTypeContribution = {
  id: "dotnet",
  label: ".NET Project",
  icon: "file-csharp",
  description: "Run a .NET project with a launch profile",
  debugAdapter: "netcoredbg",
  fields: [
    {
      key: "project",
      label: ".NET project",
      mono: true,
      required: true,
      suggestions: (configs) => [
        ...new Set(
          configs.filter((c) => c.kind === "dotnet" || c.kind === "dotnet-test").map((c) => c.params?.project || ""),
        ),
      ],
    },
    {
      key: "framework",
      label: "Target framework",
      mono: true,
      suggestions: (_configs, p) => (p.frameworks || "").split(";").filter(Boolean),
    },
    {
      key: "launchProfile",
      label: "Launch profile",
      mono: true,
      hint: "Empty disables launch profiles",
      suggestions: (_configs, p) => {
        try {
          return Object.keys(JSON.parse(p.profiles || "{}"));
        } catch {
          return [];
        }
      },
    },
    { key: "programArgs", label: "Program arguments", mono: true, hint: "Empty uses the launch profile's arguments" },
    {
      key: "applicationUrl",
      label: "Application URL",
      control: "output",
      value: (p) => profile(p).applicationUrl || "",
    },
    {
      key: "profileEnvironment",
      label: "Profile environment variables",
      control: "output",
      value: (p) =>
        Object.entries(profile(p).environmentVariables ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      hint: "Environment variables below override the profile",
    },
  ],
  commandLine: (p) => dotnetCommand(p),
  async prepareLaunch(config) {
    const resolved = await call(commands.runDotnetResolve(config, false));
    const p = resolved.params ?? {};
    // Materialize the profile so explicit environment/cwd edits also apply on older SDKs.
    const args = parseArgs(p.programArgs?.trim() ? p.programArgs : p.profileArgs || "");
    return {
      ...resolved,
      args: [
        ...dotnetCommand({ ...p, launchProfile: "", programArgs: "" }).args,
        ...(args.length ? ["--", ...args] : []),
      ],
    };
  },
};

export const dotnetTestType: RunConfigTypeContribution = {
  id: "dotnet-test",
  label: "dotnet test",
  icon: "file-csharp",
  description: "Run .NET tests",
  fields: [...dotnetProjectType.fields.slice(0, 2), { key: "programArgs", label: "Test arguments", mono: true }],
  commandLine(p) {
    const line = dotnetCommand({ ...p, programArgs: "" }, true);
    return { ...line, args: [...line.args, ...parseArgs(p.programArgs || "")] };
  },
  async prepareLaunch(config) {
    const resolved = await call(commands.runDotnetResolve(config, false));
    return { ...resolved, ...dotnetTestType.commandLine(resolved.params ?? {}) };
  },
};
