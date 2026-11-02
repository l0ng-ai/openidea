import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { commands } from "@/platform/ipc";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { dotnetBuildConfig, dotnetProjectType, dotnetTestType } from "./dotnetTypes";
import { ConfigForm } from "./ConfigForm";
import { validateConfig } from "./configs";
import { newConfigOfType, registerBuiltinTypes, withParams } from "./types";

const resolveDotnet = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, runDotnetResolve: resolveDotnet } };
});

const params = {
  project: "src/My App/App.csproj",
  framework: "net10.0",
  frameworks: "net10.0;net9.0",
  launchProfile: "local web",
  programArgs: "--name 'hello world'",
  profiles: JSON.stringify({
    "local web": { applicationUrl: "http://localhost:5165", environmentVariables: { DEMO: "profile" } },
    alternate: {},
  }),
};
let dispose: () => void;
beforeEach(() => {
  dispose = registerBuiltinTypes();
});
afterEach(() => dispose());

function config(): RunConfig {
  return withParams({ ...newConfigOfType(dotnetProjectType, []), name: "demo" }, params, dotnetProjectType);
}

describe(".NET configurations", () => {
  it("generates run/test commands with spaces, framework/profile and separated program arguments", () => {
    const c = config();
    expect(c.args).toEqual([
      "run",
      "--project",
      "src/My App/App.csproj",
      "--framework",
      "net10.0",
      "--launch-profile",
      "local web",
      "--",
      "--name",
      "hello world",
    ]);
    expect(c.debugAdapter).toBe("netcoredbg");
    expect(c.beforeLaunch).toEqual([{ kind: "dotnetBuild", target: "" }]);
    expect(validateConfig(c, [c])).toEqual({});
    const t = withParams(
      newConfigOfType(dotnetTestType, []),
      { project: params.project, framework: "net9.0", programArgs: '--filter "Category=Unit"' },
      dotnetTestType,
    );
    expect(t.isTest).toBe(true);
    expect(t.debugAdapter).toBeNull();
    expect(t.args).toEqual(["test", params.project, "--framework", "net9.0", "--filter", "Category=Unit"]);
    expect(dotnetProjectType.commandLine({ project: "App.csproj" })?.args).toEqual([
      "run",
      "--project",
      "App.csproj",
      "--no-launch-profile",
    ]);
  });

  it("builds edited project/framework from the open root instead of a profile cwd", () => {
    useProject.setState({ project: { root: "/repo" } as never });
    const c = withParams(
      { ...config(), cwd: "profile/work" },
      { ...params, project: "other/App.csproj", framework: "net9.0" },
    );
    const build = dotnetBuildConfig(c);
    expect(build.args).toEqual(["build", "other/App.csproj", "--configuration", "Debug", "--framework", "net9.0"]);
    expect(build.cwd).toBe("/repo");
    expect(build.beforeLaunch).toEqual([]);
  });

  it("edits project, framework, profile, arguments and environment in the shared form", () => {
    const c = config();
    const change = vi.fn();
    render(
      <ConfigForm config={c} all={[c]} type={dotnetProjectType} errors={{}} modifyRequest={0} onChange={change} />,
    );
    expect(screen.getByText("http://localhost:5165")).toBeTruthy();
    expect(screen.getByText("DEMO=profile")).toBeTruthy();
    for (const [label, value] of [
      [".NET project", "other/App.csproj"],
      ["Target framework", "net9.0"],
      ["Launch profile", "alternate"],
      ["Program arguments", "--edited"],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(change).toHaveBeenCalled();
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Environment variables" }), {
      target: { value: "DEMO=override" },
    });
    expect(change.mock.lastCall?.[0]).toMatchObject({ env: { DEMO: "override" } });
  });
  it("prepares Run from the freshly resolved profile while keeping explicit argument overrides", async () => {
    const c = config();
    resolveDotnet.mockResolvedValue({
      status: "ok",
      data: {
        ...c,
        cwd: "/repo/work",
        env: { DEMO: "override" },
        params: { ...params, project: "/repo/App.csproj", profileArgs: "--from-profile" },
      },
    });
    const prepared = await dotnetProjectType.prepareLaunch!(c);
    expect(commands.runDotnetResolve).toHaveBeenCalledWith(c, false);
    expect(prepared).toMatchObject({ cwd: "/repo/work", env: { DEMO: "override" } });
    expect(prepared.args).toContain("--no-launch-profile");
    expect(prepared.args.slice(-3)).toEqual(["--", "--name", "hello world"]);
  });
});
