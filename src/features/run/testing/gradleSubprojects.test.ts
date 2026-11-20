import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { testsBySubproject } from "./gradleSubprojects";

const cfg = (args: string[], over: Partial<RunConfig> = {}): RunConfig => ({
  id: "gradle:test",
  name: "Failed: gradle test",
  kind: "gradle",
  command: "./gradlew",
  args,
  cwd: null,
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
  ...over,
});

const modules: Record<string, string[]> = {
  "com.a.AlphaTest": ["alpha"],
  "com.b.BetaTest": ["services/beta"],
  "com.r.RootTest": [""],
  "com.x.Twice": ["alpha", "services/beta"],
};
const find = async (cls: string) => modules[cls] ?? [];

describe("Gradle tests by subproject", () => {
  it("runs each failed test with its own subproject's test task", async () => {
    const derived = cfg(["test", "--tests", "com.a.AlphaTest.one", "--tests", "com.b.BetaTest$Inner.two"]);
    const paths = [
      ["com.a.AlphaTest", "one()"],
      ["com.b.BetaTest$Inner", "two"],
    ];
    expect((await testsBySubproject(derived, paths, find)).args).toEqual([
      ":alpha:test",
      "--tests",
      "com.a.AlphaTest.one",
      ":services:beta:test",
      "--tests",
      "com.b.BetaTest$Inner.two",
      "--continue",
    ]);
  });

  it("keeps the other options and needs no --continue for one subproject", async () => {
    const derived = cfg(["--offline", "test", "--tests", "com.b.BetaTest"]);
    expect((await testsBySubproject(derived, [["com.b.BetaTest"]], find)).args).toEqual([
      "--offline",
      ":services:beta:test",
      "--tests",
      "com.b.BetaTest",
    ]);
  });

  it("addresses the root project's own tests as :test next to a subproject's", async () => {
    const derived = cfg(["test", "--tests", "com.r.RootTest.a", "--tests", "com.a.AlphaTest.one"]);
    const paths = [
      ["com.r.RootTest", "a"],
      ["com.a.AlphaTest", "one"],
    ];
    expect((await testsBySubproject(derived, paths, find)).args).toEqual([
      ":test",
      "--tests",
      "com.r.RootTest.a",
      ":alpha:test",
      "--tests",
      "com.a.AlphaTest.one",
      "--continue",
    ]);
  });

  it("keeps the configuration when a class is not found in exactly one module", async () => {
    const derived = cfg(["test", "--tests", "com.a.AlphaTest.one", "--tests", "com.z.Gone.x"]);
    const paths = [
      ["com.a.AlphaTest", "one"],
      ["com.z.Gone", "x"],
    ];
    expect(await testsBySubproject(derived, paths, find)).toBe(derived);
    const twice = cfg(["test", "--tests", "com.x.Twice"]);
    expect(await testsBySubproject(twice, [["com.x.Twice"]], find)).toBe(twice);
  });

  it("leaves runs alone that already name a task, run only root tests, or are not Gradle", async () => {
    const scoped = cfg([":alpha:test", "--tests", "com.a.AlphaTest.one"]);
    expect(await testsBySubproject(scoped, [["com.a.AlphaTest", "one"]], find)).toBe(scoped);
    const root = cfg(["test", "--tests", "com.r.RootTest.a"]);
    expect(await testsBySubproject(root, [["com.r.RootTest", "a"]], find)).toBe(root);
    const maven = cfg(["test", "-Dtest=com.a.AlphaTest#one"], { kind: "maven", command: "./mvnw" });
    expect(await testsBySubproject(maven, [["com.a.AlphaTest", "one"]], find)).toBe(maven);
  });
});
