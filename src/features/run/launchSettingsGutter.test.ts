import { afterEach, describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { profileConfig, projectProfiles } from "./launchSettingsGutter";

const SETTINGS = `﻿{
  "$schema": "https://json.schemastore.org/launchsettings.json",
  "profiles": {
    "http": {
      "commandName": "Project",
      "applicationUrl": "http://localhost:5170"
    },
    "IIS Express": {
      "commandName": "IISExpress"
    },
    "https": {
      "commandName": "Project"
    }
  }
}`;

const config = (id: string, name: string, launchProfile: string): RunConfig =>
  ({
    id,
    name,
    kind: "dotnet",
    command: "dotnet",
    args: ["run", "--project", "src/Api/Api.csproj"],
    params: { project: "src/Api/Api.csproj", framework: "net9.0", launchProfile },
  }) as unknown as RunConfig;

afterEach(() => useProject.setState({ project: null }));

describe("launchSettings.json run icons", () => {
  it("mark the profiles a run can use, on their lines", () => {
    expect(projectProfiles(SETTINGS)).toEqual([
      { name: "http", line: 3 },
      { name: "https", line: 10 },
    ]);
    // While the file doesn't parse, every profile keeps its icon.
    expect(projectProfiles(SETTINGS.replace('"https": {', '"https": {,')).map((e) => e.name)).toEqual([
      "http",
      "IIS Express",
    ]);
  });

  it("run the project's configuration for the profile, or a temporary copy of it", () => {
    useProject.setState({ project: { root: "/repo" } as never });
    const path = "/repo/src/Api/Properties/launchSettings.json";
    const configs = [
      config("dotnet:src/Api/Api.csproj:run:", "Api (.NET Project)", ""),
      config("dotnet:src/Api/Api.csproj:run:http", "Api: http", "http"),
    ];
    expect(profileConfig(configs, path, "http")).toEqual({ config: configs[1], saved: true });
    const added = profileConfig(configs, path, "https")!;
    expect(added.saved).toBe(false);
    expect(added.config.name).toBe("Api: https");
    expect(added.config.params?.launchProfile).toBe("https");
    expect(added.config.args).toEqual([
      "run",
      "--project",
      "src/Api/Api.csproj",
      "--framework",
      "net9.0",
      "--launch-profile",
      "https",
    ]);
    expect(profileConfig(configs, "/repo/src/Other/Properties/launchSettings.json", "http")).toBeNull();
  });
});
