import { describe, expect, it } from "vitest";
import { hasIcon } from "@/ui/icons";
import { detectProjectType, PROJECT_TYPES } from "./projectType";

const detect = (files: Record<string, string>) => detectProjectType(new Map(Object.entries(files)));

describe("project type detection", () => {
  it.each([
    ["io.quarkus", "quarkus"],
    ["org.springframework.boot", "spring"],
    ["io.ktor.plugin", "ktor"],
    ["org.jetbrains.compose", "compose"],
    ["org.jetbrains.kotlin.multiplatform", "kmp"],
    ["com.android.application", "android"],
  ])("detects the %s plugin in Kotlin/Groovy and version catalogs", (plugin, expected) => {
    for (const [name, text] of [
      ["build.gradle.kts", `plugins { id("${plugin}") version "1" }`],
      ["build.gradle", `plugins { id '${plugin}' version '1' }`],
      ["gradle/libs.versions.toml", `[plugins]\nframework = { id = "${plugin}", version = "1" }`],
    ])
      expect(detect({ [name!]: text! })).toBe(expected);
  });
  it.each([
    ["io.quarkus.platform", "quarkus"],
    ["org.springframework.boot", "spring"],
    ["io.ktor", "ktor"],
  ])("detects Maven dependency/plugin groups %s", (group, expected) => {
    expect(
      detect({
        "pom.xml": `<project><dependencies><dependency><groupId>${group}</groupId></dependency></dependencies></project>`,
      }),
    ).toBe(expected);
  });
  it.each([
    ["next", "next"],
    ["nuxt", "nuxt"],
    ["@sveltejs/kit", "sveltekit"],
    ["@angular/core", "angular"],
    ["@nestjs/core", "nest"],
    ["astro", "astro"],
    ["svelte", "svelte"],
    ["vue", "vue"],
    ["react", "react"],
    ["express", "express"],
  ])("detects declared Node framework %s", (dependency, expected) => {
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
      expect(detect({ "package.json": JSON.stringify({ [section]: { [dependency]: "1" } }) })).toBe(expected);
  });
  it("prefers Next.js over React and SvelteKit over Svelte", () => {
    expect(detect({ "package.json": JSON.stringify({ dependencies: { react: "19", next: "16" } }) })).toBe("next");
    expect(detect({ "package.json": JSON.stringify({ devDependencies: { svelte: "5", "@sveltejs/kit": "2" } }) })).toBe(
      "sveltekit",
    );
  });
  it("uses Vite as a build-tool fallback while keeping framework identities first", () => {
    expect(detect({ "package.json": JSON.stringify({ devDependencies: { vite: "8" } }) })).toBe("vite");
    expect(detect({ "package.json": JSON.stringify({ devDependencies: { vite: "8", react: "19" } }) })).toBe("react");
    expect(detect({ "package.json": JSON.stringify({ dependencies: { vite: "8", next: "16", react: "19" } }) })).toBe(
      "next",
    );
  });
  it.each(["fastapi", "django", "flask"])("detects Python framework %s", (name) => {
    for (const [file, text] of [
      ["requirements.txt", `${name}[standard]>=1\n`],
      ["pyproject.toml", `[project]\ndependencies = ["${name}>=1"]`],
      ["pyproject.toml", `[tool.poetry.dependencies]\n${name} = "^1"`],
      ["Pipfile", `[packages]\n${name} = "*"`],
    ])
      expect(detect({ [file!]: text! })).toBe(name);
  });
  it("detects Flutter and Compose Multiplatform independently of their base language", () => {
    expect(detect({ "pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter" })).toBe("flutter");
    expect(detect({ "pubspec.yaml": "dependencies: { flutter: { sdk: flutter } }" })).toBe("flutter");
    expect(detect({ "build.gradle.kts": 'plugins { kotlin("multiplatform"); id("org.jetbrains.compose") }' })).toBe(
      "compose",
    );
  });
  it("ignores comments, package names, scripts and similarly named dependencies", () => {
    expect(
      detect({
        "package.json": JSON.stringify({
          name: "next",
          scripts: { dev: "next dev" },
          dependencies: { "react-icons": "1" },
        }),
      }),
    ).toBe("node");
    expect(detect({ "build.gradle.kts": '// id("io.quarkus")\n/* id("org.jetbrains.compose") */' })).toBe("gradle");
    expect(detect({ "pom.xml": "<project><!-- <groupId>io.quarkus</groupId> --></project>" })).toBe("maven");
    expect(detect({ "requirements.txt": "# fastapi>=1\nnot-fastapi==1" })).toBe("python");
    expect(detect({ "pyproject.toml": '[project]\nname = "fastapi"\ndescription = "django"' })).toBe("python");
  });
  it("keeps language/build fallbacks for empty, malformed and unknown manifests", () => {
    for (const [file, type] of [
      ["go.mod", "go"],
      ["Cargo.toml", "rust"],
      ["pyproject.toml", "python"],
      ["build.gradle.kts", "gradle"],
      ["pom.xml", "maven"],
      ["pubspec.yaml", "dart"],
      ["composer.json", "php"],
      ["Game.csproj", "dotnet"],
    ])
      expect(detect({ [file!]: "" })).toBe(type);
    expect(detect({ "package.json": "{ broken" })).toBe("node");
    expect(detect({ "README.md": "Flutter Next.js Quarkus" })).toBeNull();
  });
  it("has an SVG for every project type", () => {
    for (const { icon } of Object.values(PROJECT_TYPES)) expect(hasIcon(icon), icon).toBe(true);
  });
});
