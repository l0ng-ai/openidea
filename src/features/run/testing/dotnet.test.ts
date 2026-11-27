import { describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { DotnetReports, trxEvents } from "./dotnet";
import { frameworkFor, TestResults } from "./index";
import { failedTestPaths, rerunFailedConfig } from "./rerun";
import { dotnetTestType } from "../dotnetTypes";
import xunitReport from "./fixtures/xunit.trx?raw";
import nunitReport from "./fixtures/nunit.trx?raw";
import mstestReport from "./fixtures/mstest.trx?raw";
import mtpReport from "./fixtures/mtp.trx?raw";

const config: RunConfig = {
  id: "dotnet:tests",
  name: "Tests",
  kind: "dotnet-test",
  command: "dotnet",
  args: ["test", "Tests.csproj"],
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
  params: {
    project: "Tests.csproj",
    framework: "net9.0",
    programArgs: "--filter Category=Unit --no-restore -- RunConfiguration.MaxCpuCount=1",
  },
};

function report(adapter: string, source = "C:/My Project/bin/net9.0/Tests.dll") {
  return `<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
    <Results>
      <UnitTestResult testId="a" testName="adds (1)" outcome="Passed" duration="00:00:00.0015"/>
      <UnitTestResult testId="b" testName="adds (2)" outcome="Failed" duration="00:01:02.5"><Output><ErrorInfo>
        <Message>Expected &lt;3&gt;</Message><StackTrace>at Sample.Tests.Adds(Int32 value) in C:\\My Project\\Tests.cs:line 12</StackTrace>
      </ErrorInfo><StdOut>captured output</StdOut></Output></UnitTestResult>
      <UnitTestResult testId="c" testName="skipped" outcome="NotExecuted"/>
    </Results>
    <TestDefinitions>
      <UnitTest id="a"><TestMethod codeBase="${source}" adapterTypeName="${adapter}" className="Sample.Tests" name="Adds"/></UnitTest>
      <UnitTest id="b"><TestMethod codeBase="${source}" adapterTypeName="${adapter}" className="Sample.Tests" name="Adds"/></UnitTest>
      <UnitTest id="c"><TestMethod codeBase="${source}" adapterTypeName="${adapter}" className="Sample.Tests" name="Skipped"/></UnitTest>
    </TestDefinitions>
  </TestRun>`;
}

describe(".NET test reports", () => {
  it("finds source locations in MTP stack traces without the VSTest line prefix", () => {
    expect(trxEvents(mtpReport)).toContainEqual(
      expect.objectContaining({
        type: "location",
        location: { path: "C:\\Fixture\\Native\\Test1.cs", line: 5, resolve: "path" },
      }),
    );
  });
  it.each([xunitReport, nunitReport, mstestReport, mtpReport])(
    "reads actual VSTest reports and selects failed methods",
    async (xml) => {
      const results = new TestResults();
      results.apply(trxEvents(xml));
      expect(results.counts()).toEqual({ passed: 2, failed: 2, skipped: 1, running: 0, total: 5 });
      const rerun = await rerunFailedConfig(config, failedTestPaths(results));
      const args = dotnetTestType.commandLine(rerun!.params!)!.args;
      expect(args[args.indexOf("--filter") + 1]!.split("|").sort()).toEqual([
        "FullyQualifiedName=Sample.CalculatorTests.Fails",
        "FullyQualifiedName=Sample.CalculatorTests.Parameterized",
      ]);
    },
  );
  it.each([
    "executor://xunit/VsTestRunner2/netcoreapp",
    "executor://nunit3testexecutor/",
    "executor://mstestadapter/v2",
  ])("reads outcomes, parameterized names, duration and source from %s", (adapter) => {
    const results = new TestResults();
    results.apply(trxEvents(report(adapter)));
    expect(results.counts()).toEqual({ passed: 1, failed: 1, skipped: 1, running: 0, total: 3 });
    const failed = results.firstFailure()!;
    expect(failed.name).toBe("adds (2)");
    expect(failed.durationMs).toBe(62500);
    expect(failed.output).toContain("Expected <3>");
    expect(failed.output).toContain("captured output");
    expect(failed.location).toEqual({ path: "C:\\My Project\\Tests.cs", line: 12, resolve: "path" });
  });

  it("keeps assemblies and target frameworks separate", () => {
    const results = new TestResults();
    for (const source of ["/a/bin/net9.0/Tests.dll", "/a/bin/net8.0/Tests.dll", "/b/bin/net9.0/Tests.dll"])
      results.apply(trxEvents(report("adapter", source)));
    expect(results.roots).toHaveLength(3);
    expect(results.counts().total).toBe(9);
  });

  it("rejects incomplete reports", () => {
    expect(() => trxEvents("<TestRun>")).toThrow("Invalid TRX");
    expect(() => trxEvents("<html/>")).toThrow("Invalid TRX");
  });

  it("inserts the logger before runsettings and reads only this invocation's announced paths", async () => {
    const reports = new DotnetReports();
    const launched = reports.launch({ ...config, args: ["test", "Tests.csproj", "--", "x=y"] });
    expect(launched.args).toEqual([
      "test",
      "Tests.csproj",
      "--logger",
      `trx;LogFilePrefix=${reports.prefix}`,
      "--",
      "x=y",
    ]);
    const windows = `C:\\My Project\\TestResults\\${reports.prefix}_net9.0.trx`;
    const unix = `/tmp/My Project/${reports.prefix}_net8.0.trx`;
    reports.feed("Results File: C:\\old.trx");
    reports.feed(`结果文件: ${windows}`);
    reports.feed(`Results File: ${windows}`);
    reports.feed(`Results File: ${unix}`);
    const read = vi.fn().mockResolvedValue(report("adapter"));
    expect(await reports.read(read)).not.toHaveLength(0);
    expect(read.mock.calls).toEqual([[windows], [unix]]);
  });

  it("detects typed configurations and direct dotnet test commands", () => {
    expect(frameworkFor(config)).toBe("dotnet");
    expect(frameworkFor({ ...config, kind: "shell", command: "C:\\Program Files\\dotnet\\dotnet.exe" })).toBe("dotnet");
    expect(frameworkFor({ ...config, kind: "shell", args: ["build"] })).toBe("auto");
  });

  it("keeps a method filter through .NET command regeneration and preserves runsettings", async () => {
    const results = new TestResults();
    results.apply(trxEvents(report("adapter")));
    const selected = await rerunFailedConfig(config, failedTestPaths(results));
    expect(selected).not.toBeNull();
    const line = dotnetTestType.commandLine(selected!.params!);
    expect(line?.args).toEqual([
      "test",
      "Tests.csproj",
      "--framework",
      "net9.0",
      "--no-restore",
      "--filter",
      "FullyQualifiedName=Sample.Tests.Adds",
      "--",
      "RunConfiguration.MaxCpuCount=1",
    ]);
    expect(config.params?.programArgs).toContain("Category=Unit");
  });
});
