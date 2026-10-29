import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { activateFeatures } from "@/features";
import { useContributions } from "@/workbench/contributions";
import { Icon, ICON_NAMES, SymbolBadge, fileIconName, hasIcon, iconMarkup, iconMarkupOrFallback } from "./icons";

describe("tool window icons", () => {
  let dispose: () => void = () => {};
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dispose = activateFeatures();
  });
  afterAll(() => {
    dispose();
    vi.restoreAllMocks();
  });

  it("gives every built-in tool window its own existing icon", () => {
    const windows = [...useContributions.getState().toolWindows.values()];
    const ids = windows.map((w) => w.id);
    for (const id of [
      "project",
      "structure",
      "bookmarks",
      "find",
      "usages",
      "hierarchy",
      "problems",
      "commit",
      "git",
    ]) {
      expect(ids).toContain(id);
    }
    const icons = windows.map((w) => w.icon);
    for (const icon of icons) expect(hasIcon(icon), icon).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("Icon", () => {
  it("resolves every name to an SVG asset", () => {
    for (const name of ICON_NAMES) expect(iconMarkup(name), name).toMatch(/^<svg/);
  });

  it("falls back like <Icon> for unknown names, without React", () => {
    const { container } = render(<Icon name="symbol-macro" />);
    expect(iconMarkupOrFallback("symbol-macro")).toBe(container.innerHTML);
    const withoutIds = (html: string) => html.replace(/\bm\d+-/g, "");
    expect(withoutIds(iconMarkupOrFallback("no-such-icon"))).toBe(withoutIds(iconMarkup("file")!));
  });

  it("renders monochrome icons with currentColor and coloured ones with both theme variants", () => {
    const { container } = render(
      <>
        <Icon name="search" />
        <Icon name="file-python" />
      </>,
    );
    const [mono, colour] = container.querySelectorAll("svg");
    expect(mono!.innerHTML).toContain("currentColor");
    expect(mono!.innerHTML).not.toMatch(/#6C707E/i);
    expect(colour!.querySelectorAll("g")).toHaveLength(2);
  });

  it("uses the 20px variant for large tool window icons", () => {
    const { container } = render(<Icon name="toolwindow-project" size={20} />);
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 20 20");
  });

  it("makes element ids unique per instance", () => {
    const { container } = render(
      <>
        <Icon name="sun" />
        <Icon name="sun" />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of container.innerHTML.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref[1]);
  });

  it("falls back to a letter badge for symbol kinds without a node icon", () => {
    const { container } = render(
      <>
        <SymbolBadge kind="class" />
        <SymbolBadge kind="keyword" />
      </>,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toBe("k");
  });
});

describe("fileIconName", () => {
  it.each([
    ["main.py", "file-python"],
    ["requirements.txt", "file-requirements"],
    ["requirements-dev.txt", "file-requirements"],
    ["pyproject.toml", "file-pyproject"],
    ["Pipfile", "file-pipenv"],
    ["notebook.ipynb", "file-jupyter"],
    ["index.js", "file-js"],
    ["App.jsx", "file-jsx"],
    ["api.ts", "file-ts"],
    ["types.d.ts", "file-ts"],
    ["App.TSX", "file-tsx"],
    ["package.json", "file-npm"],
    ["package-lock.json", "file-lock"],
    ["yarn.lock", "file-lock"],
    ["pnpm-lock.yaml", "file-lock"],
    ["Cargo.toml", "file-cargo"],
    ["Cargo.lock", "file-lock"],
    ["poetry.lock", "file-lock"],
    ["Gemfile", "file-ruby"],
    ["Gemfile.lock", "file-lock"],
    ["go.mod", "file-gomod"],
    ["go.sum", "file-lock"],
    ["go.work", "file-gowork"],
    ["tsconfig.json", "file-config"],
    ["tsconfig.app.json", "file-config"],
    ["vite.config.ts", "file-config"],
    ["eslint.config.mjs", "file-config"],
    [".prettierrc", "file-config"],
    [".eslintrc.json", "file-config"],
    ["data.json", "file-json"],
    ["README.md", "file-md"],
    ["README", "file-readme"],
    ["LICENSE", "file-license"],
    ["LICENSE-MIT", "file-license"],
    ["license.ts", "file-ts"],
    ["CHANGELOG", "file-text"],
    ["config.yml", "file-yaml"],
    ["config.toml", "file-toml"],
    ["schema.sql", "file-sql"],
    ["schema.graphql", "file-graphql"],
    ["api.proto", "file-proto"],
    ["main.go", "file-go"],
    ["main.c", "file-c"],
    ["util.h", "file-h"],
    ["util.hpp", "file-h"],
    ["main.cpp", "file-cpp"],
    ["main.cc", "file-cpp"],
    ["Program.cs", "file-csharp"],
    ["lib.rs", "file-rust"],
    ["Main.kt", "file-kotlin"],
    ["script.kts", "file-kotlin-script"],
    ["build.gradle", "file-gradle"],
    ["build.gradle.kts", "file-gradle-kts"],
    ["pom.xml", "file-maven"],
    ["App.swift", "file-swift"],
    ["app.rb", "file-ruby"],
    ["init.lua", "file-lua"],
    ["build.zig", "file-zig"],
    ["main.dart", "file-dart"],
    ["App.vue", "file-vue"],
    ["App.svelte", "file-svelte"],
    ["styles.scss", "file-scss"],
    ["styles.sass", "file-sass"],
    ["styles.less", "file-less"],
    ["Dockerfile", "file-docker"],
    ["Dockerfile.dev", "file-docker"],
    ["api.Dockerfile", "file-docker"],
    ["docker-compose.yml", "file-docker"],
    ["compose.yaml", "file-docker"],
    [".dockerignore", "file-ignored"],
    ["Makefile", "file-makefile"],
    ["rules.mk", "file-makefile"],
    ["CMakeLists.txt", "file-cmake"],
    ["toolchain.cmake", "file-cmake"],
    ["main.tf", "file-terraform"],
    ["config.hcl", "file-hcl"],
    ["Jenkinsfile", "file-jenkins"],
    ["BUILD.bazel", "file-bazel"],
    [".gitignore", "file-git"],
    [".editorconfig", "file-config"],
    [".env", "file-dotenv"],
    [".env.example", "file-dotenv"],
    [".envrc", "file-shell"],
    ["run.sh", "file-shell"],
    ["build.ps1", "file-powershell"],
    ["build.bat", "file-windows"],
    ["run.cmd", "file-windows"],
    ["server.log", "file-log"],
    ["paper.tex", "file-latex"],
    ["photo.PNG", "file-image"],
    ["main.sol", "file-code"],
    [".vimrc", "file-text"],
    ["data.xyz", "file-unknown"],
  ])("%s → %s", (file, icon) => {
    expect(fileIconName(file)).toBe(icon);
  });

  it("gives every detected language file a specific icon", () => {
    const dir = path.join(process.cwd(), "languages");
    const list = (src: string, key: string) =>
      [...(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(src)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
        (m) => m[1]!,
      );
    const generic = new Set(["file-unknown", "file-code", "file-text"]);
    const misses: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".toml"))) {
      if (file === "plaintext.toml") continue;
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const names = [
        ...list(src, "extensions").map((e) => `name.${e}`),
        ...list(src, "filenames").map((n) => n.replace("*", "x")),
      ];
      for (const name of names) if (generic.has(fileIconName(name))) misses.push(`${file}: ${name}`);
    }
    expect(misses).toEqual([]);
  });

  it("never shows two file types with the same glyph", () => {
    const aliases = new Set(["file"]);
    const seen = new Map<string, string>();
    for (const name of ICON_NAMES.filter((n) => n.startsWith("file") && !aliases.has(n))) {
      const markup = iconMarkup(name)!.replace(/\bm\d+-/g, "");
      expect(seen.get(markup), name).toBeUndefined();
      seen.set(markup, name);
    }
  });
});
