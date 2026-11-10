import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { frameworkFor } from "./testing";
import { jdwpLaunch } from "./javaDebug";
import { junitCommandLine } from "./junitType";

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: over.kind === "maven" ? "./mvnw" : "./gradlew",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...over,
});

const maven = [cfg({ id: "maven:test", kind: "maven", args: ["test"], isTest: true })];
const gradle = [cfg({ id: "gradle:api:test", kind: "gradle", args: [":api:test"], isTest: true, cwd: "api" })];

describe("JUnit configurations", () => {
  it("narrow the module's Maven tests like the gutter's Run", () => {
    const line = (p: Record<string, string>) => junitCommandLine({ module: ".", ...p }, maven);
    expect(line({ testKind: "class", className: "a.OrderTest" })).toEqual({
      command: "./mvnw",
      args: ["test", "-Dtest=a.OrderTest", "-Dsurefire.failIfNoSpecifiedTests=false"],
      cwd: null,
    });
    expect(line({ testKind: "method", className: "a.OrderTest", methodName: "ships" }).args).toEqual([
      "test",
      "-Dtest=a.OrderTest#ships",
      "-Dsurefire.failIfNoSpecifiedTests=false",
    ]);
    expect(line({ testKind: "package", packageName: "a.b" }).args).toEqual([
      "test",
      "-Dtest=a.b.**.*",
      "-Dsurefire.failIfNoSpecifiedTests=false",
    ]);
    expect(line({ testKind: "pattern", pattern: "*IT, a.**.*Test" }).args).toEqual([
      "test",
      "-Dtest=*IT,a.**.*Test",
      "-Dsurefire.failIfNoSpecifiedTests=false",
    ]);
    expect(line({ testKind: "all", vmOptions: "-Xmx1g -Da=b" }).args).toEqual(["test", "-DargLine=-Xmx1g -Da=b"]);
  });

  it("use the Gradle module's test task and its working directory", () => {
    const line = (p: Record<string, string>) => junitCommandLine({ module: "api", ...p }, gradle);
    expect(line({ testKind: "method", className: "a.OrderTest", methodName: "ships" })).toEqual({
      command: "./gradlew",
      args: [":api:test", "--tests", "a.OrderTest.ships"],
      cwd: "api",
    });
    expect(line({ testKind: "pattern", pattern: "*IT,*Spec" }).args).toEqual([
      ":api:test",
      "--tests",
      "*IT",
      "--tests",
      "*Spec",
    ]);
    // Gradle takes VM options from an init script at launch, not from the command line.
    expect(line({ testKind: "all", vmOptions: "-Xmx1g" }).args).toEqual([":api:test"]);
  });

  it("run nothing without a Maven or Gradle build, and debug and report like build runs", () => {
    expect(junitCommandLine({ testKind: "all" }, []).command).toBe("");
    const line = junitCommandLine({ testKind: "class", className: "a.OrderTest" }, maven);
    const config = cfg({ id: "j", kind: "junit", isTest: true, ...line });
    expect(frameworkFor(config)).toBe("jvm");
    expect(jdwpLaunch(config)?.args.join(" ")).toMatch(/-Dmaven\.surefire\.debug=/);
  });
});
