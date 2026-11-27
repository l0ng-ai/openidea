import { describe, expect, it } from "vitest";
import { solutionPaths, jsonOutput, dotnetTestArgs, globalRunner, type DotnetProject } from "./dotnet";
import { dotnetTestType } from "@/features/run/dotnetTypes";
import { DotnetReports } from "@/features/run/testing/dotnet";

const project: DotnetProject = {
  path: "C:/My Repo/Tests.csproj",
  name: "Tests",
  frameworks: ["net9.0"],
  configurations: ["Debug", "Release"],
  references: [],
  packages: [],
  test: true,
  runner: "vstest",
  adapter: "mstest",
  trx: true,
};
describe(".NET workspace formats and runners", () => {
  it("reads global.json comments and trailing commas without changing string values", () => {
    expect(
      globalRunner(
        '{ // comment\n "test": { "runner": "Microsoft.Testing.Platform", }, "unused": "https://example.com/,}", }',
      ),
    ).toBe("mtp");
  });
  it("keeps SDK options before the legacy MTP argument boundary", () => {
    const line = dotnetTestType.commandLine({
      project: project.path,
      runner: "mtp-legacy",
      programArgs: "--no-build --filter Name=One",
      testMethods: '["A.Tests.Two"]',
    })!;
    expect(line.args.indexOf("--no-build")).toBeLessThan(line.args.indexOf("--"));
    expect(line.args.slice(line.args.indexOf("--") + 1)).toEqual(["--filter", "FullyQualifiedName=A.Tests.Two"]);
  });
  it("resolves solution projects, XML entities and external references", () => {
    expect(
      solutionPaths(
        'Project("id") = "Tests", "..\\outside\\Tests.csproj", "id"\nProject("id") = "Folder", "Folder", "id"',
        false,
        "C:/repo",
      ),
    ).toEqual(["C:/outside/Tests.csproj"]);
    expect(
      solutionPaths(
        '<Solution><Folder Name="src"><Project Path="A&amp;B/App.csproj" /></Folder></Solution>',
        true,
        "/repo",
      ),
    ).toEqual(["/repo/A&B/App.csproj"]);
  });
  it("reads JSON despite SDK banners", () =>
    expect(jsonOutput('Welcome\n{"Properties":{"TargetFramework":"net9.0"}}\n')).toEqual({
      Properties: { TargetFramework: "net9.0" },
    }));
  it.each(["vstest", "mtp", "mtp-legacy"] as const)(
    "keeps %s discovery arguments in the correct command layer",
    (runner) => {
      const args = dotnetTestArgs({ ...project, runner }, "net9.0", ["--list-tests"], "Release");
      expect(args.includes("--project")).toBe(runner === "mtp");
      expect(args.includes("--")).toBe(runner === "mtp-legacy");
      expect(args.at(-1)).toBe("--list-tests");
    },
  );
  it.each(["mtp", "mtp-legacy"])("launches %s with TRX and adapter-native selectors", (runner) => {
    const p = {
      project: project.path,
      framework: "net9.0",
      runner,
      adapter: "xunit",
      testMethods: JSON.stringify(["A.Tests.One", "A.Tests.Two"]),
    };
    const line = dotnetTestType.commandLine(p)!;
    expect(line.args).toContain("--filter-method");
    expect(line.args).not.toContain("--filter");
    const reporting = new DotnetReports().launch({
      id: "test",
      name: "test",
      kind: "dotnet-test",
      ...line,
      params: p,
      cwd: null,
      env: {},
      isTest: true,
      detected: true,
      debugAdapter: null,
    });
    expect(reporting.args).toContain("--report-trx");
    expect(reporting.args).not.toContain("--logger");
  });
});
