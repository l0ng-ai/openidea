import { describe, expect, it } from "vitest";
import { withMavenTests } from "./mavenTests";

describe("withMavenTests", () => {
  it("runs the selected tests even when the build or the configuration skips tests", () => {
    // `skipTests` in the POM's `<properties>` or `.mvn/maven.config` only compiled: `-D` on the command line wins.
    expect(withMavenTests(["test", "-DskipTests", "-Dmaven.test.skip=true", "-o"], "demo.DemoTest#test1")).toEqual([
      "test",
      "-o",
      "-Dtest=demo.DemoTest#test1",
      "-Dsurefire.failIfNoSpecifiedTests=false",
      "-DskipTests=false",
      "-Dmaven.test.skip=false",
    ]);
  });
});
