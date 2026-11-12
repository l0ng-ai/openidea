import { call, commands, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { commandName } from "./commandName";
import { prepareDotnetTest } from "@/platform/dotnet";

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
      ...(p.configuration ? ["--configuration", p.configuration] : []),
      ...(!test ? (p.launchProfile ? ["--launch-profile", p.launchProfile] : ["--no-launch-profile"]) : []),
      ...(p.programArgs?.trim() ? ["--", ...parseArgs(p.programArgs)] : []),
    ],
  };
}

/**
 * The form fields of a `dotnet run` command line ([`dotnetCommand`] reversed), or `null` when it
 * uses anything the form can't show. Lets a new configuration, and one typed as a command, open
 * as the form with its project field.
 */
function dotnetRunParams(c: RunConfig): Record<string, string> | null {
  if (!/^dotnet(\.exe)?$/i.test(commandName(c.command))) return null;
  const [verb, ...rest] = c.args;
  if (verb !== "run") return null;
  const p: Record<string, string> = c.command === "dotnet" ? {} : { executable: c.command };
  const flags: Record<string, string> = {
    "--project": "project",
    "--framework": "framework",
    "--configuration": "configuration",
    "--launch-profile": "launchProfile",
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") {
      p.programArgs = formatArgs(rest.slice(i + 1));
      break;
    }
    if (arg === "--no-launch-profile") continue;
    const key = flags[arg];
    const value = rest[i + 1];
    if (!key || value === undefined) return null;
    p[key] = value;
    i++;
  }
  return { project: "", ...p };
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
  paramsFrom: dotnetRunParams,
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
    if (p.runner === "mtp") line.args.splice(1, 0, "--project");
    if (p.runner === "mtp-legacy")
      line.args.push("-p:TestingPlatformCaptureOutput=false", "-p:TestingPlatformDotnetTestSupport=true");
    let extra = parseArgs(p.programArgs || "");
    if (p.runner === "mtp-legacy") {
      const boundary = extra.indexOf("--");
      if (boundary >= 0) {
        line.args.push(...extra.slice(0, boundary));
        extra = extra.slice(boundary + 1);
      } else {
        const runner: string[] = [];
        const options = new Set(["--configuration", "-c", "--framework", "-f", "--runtime", "-r", "--verbosity", "-v"]);
        for (let i = 0; i < extra.length; i++) {
          const arg = extra[i]!;
          if (options.has(arg)) line.args.push(arg, extra[++i] ?? "");
          else if (/^(?:--no-build$|--no-restore$|-p:|-property:|--property:)/.test(arg)) line.args.push(arg);
          else runner.push(arg);
        }
        extra = runner;
      }
    }
    if (p.testMethods) {
      const methods = JSON.parse(p.testMethods) as string[];
      const flags = new Set(["--filter", "--filter-method"]);
      extra = extra.filter((a, i, all) => !flags.has(a) && !flags.has(all[i - 1] ?? "") && !a.startsWith("--filter="));
      const selection =
        p.runner !== "vstest" && p.runner && p.adapter === "xunit"
          ? methods.flatMap((m) => ["--filter-method", m.includes(".") ? m : `*.${m}`])
          : [
              "--filter",
              methods
                .map((m) => `${m.includes(".") ? "FullyQualifiedName" : "Name"}=${m.replace(/[\\()&|=!~]/g, "\\$&")}`)
                .join("|"),
            ];
      const boundary = extra.indexOf("--");
      extra.splice(boundary < 0 ? extra.length : boundary, 0, ...selection);
    }
    return {
      ...line,
      args: [...line.args, ...(p.runner === "mtp-legacy" && extra[0] !== "--" ? ["--"] : []), ...extra],
    };
  },
  async prepareLaunch(config) {
    const resolved = await prepareDotnetTest(await call(commands.runDotnetResolve(config, false)));
    return { ...resolved, ...dotnetTestType.commandLine(resolved.params ?? {}) };
  },
};
