import { describe, expect, it } from "vitest";
import { hasIcon } from "@/ui/icons";
import { detectProjectType, isProjectMarker, PROJECT_TYPES } from "./projectType";

describe("project types", () => {
  it.each([
    ["build.gradle.kts", "gradle"],
    ["build.gradle", "gradle"],
    ["settings.gradle.kts", "gradle"],
    ["settings.gradle", "gradle"],
    ["pom.xml", "maven"],
    ["go.mod", "go"],
    ["go.work", "go"],
    ["Cargo.toml", "cargo"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Pipfile", "python"],
    ["setup.py", "python"],
    ["setup.cfg", "python"],
    ["package.json", "node"],
    ["pubspec.yaml", "dart"],
    ["composer.json", "php"],
    ["Gemfile", "ruby"],
    ["Package.swift", "swift"],
    ["build.zig", "zig"],
    ["project.godot", "godot"],
    ["CMakeLists.txt", "cmake"],
    ["Makefile", "make"],
    ["makefile", "make"],
    ["GNUmakefile", "make"],
    ["App.csproj", "dotnet"],
    ["Library.fsproj", "dotnet"],
    ["App.sln", "dotnet"],
    ["App.slnx", "dotnet"],
  ])("recognizes %s without reading its contents", (marker, expected) => {
    expect(isProjectMarker(marker)).toBe(true);
    expect(detectProjectType(new Set([marker]))).toBe(expected);
  });
  it("distinguishes Flutter SDK projects from Dart packages", () => {
    expect(detectProjectType(new Set(["pubspec.yaml", ".metadata"]))).toBe("flutter");
    expect(detectProjectType(new Set(["pubspec.yaml"]))).toBe("dart");
    expect(detectProjectType(new Set([".metadata"]))).toBeNull();
  });
  it.each(["js", "ts", "mjs", "mts", "cjs", "cts"])("recognizes the Vite build type from vite.config.%s", (ext) => {
    const marker = `vite.config.${ext}`;
    expect(isProjectMarker(marker)).toBe(true);
    expect(detectProjectType(new Set(["package.json", marker]))).toBe("vite");
    expect(detectProjectType(new Set([marker]))).toBeNull();
  });
  it("keeps Node projects together regardless of their framework configuration", () => {
    expect(detectProjectType(new Set(["package.json", "next.config.mjs"]))).toBe("node");
    expect(detectProjectType(new Set(["package.json", "svelte.config.js"]))).toBe("node");
  });
  it("uses a build manifest ahead of generic build helpers", () => {
    expect(detectProjectType(new Set(["go.mod", "Makefile"]))).toBe("go");
    expect(detectProjectType(new Set(["CMakeLists.txt", "Makefile"]))).toBe("cmake");
  });
  it("does not infer a type from source files, directory names or nested manifests", () => {
    for (const marker of ["src/main.go", "main.py", "flutter", "build", "node_modules", "README.md", "app/pom.xml"])
      expect(detectProjectType(new Set([marker])), marker).toBeNull();
  });
  it("has an existing SVG for every project type", () => {
    for (const { icon } of Object.values(PROJECT_TYPES)) expect(hasIcon(icon), icon).toBe(true);
  });
  it.each(Object.entries(PROJECT_TYPES))("derives %s detection and refresh from its registry entry", (id, type) => {
    const required = "requires" in type ? type.requires : [];
    for (const marker of required) expect(isProjectMarker(marker)).toBe(true);
    for (const marker of type.markers) {
      if (typeof marker !== "string") continue;
      expect(isProjectMarker(marker)).toBe(true);
      expect(detectProjectType(new Set([marker, ...required]))).toBe(id);
    }
  });
});
