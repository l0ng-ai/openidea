import { expect, it } from "vitest";
import { isGradleBuildInput } from "./buildFiles";

it("recognizes applied scripts and Gradle properties for build and library refresh", () => {
  for (const path of [
    "/p/gradle/dependencies.gradle",
    "/p/gradle/dependencies.gradle.kts",
    "C:\\p\\gradle\\dependencies.gradle",
    "/p/gradle.properties",
    "/p/gradle/wrapper/gradle-wrapper.properties",
    "/p/gradle/libs.versions.toml",
  ]) {
    expect(isGradleBuildInput(path), path).toBe(true);
  }
  for (const path of ["/p/dependencies.gradle.bak", "/p/src/main.kt", "/p/README.md"]) {
    expect(isGradleBuildInput(path), path).toBe(false);
  }
});
