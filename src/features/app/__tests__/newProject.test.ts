import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileIconName } from "@/ui";
import { joinPath, joinRelative, projectNameError } from "../NewProject";
import { groupedProjectKinds, PROJECT_KINDS, projectKindIcon } from "../newProjectLanguages";
import { projectNames, starterFiles } from "../newProjectTemplates";
import { exportedStorage } from "../projectActions";

function definedLanguages(): { id: string; name: string }[] {
  const dir = join(process.cwd(), "languages");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".toml"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const id = text.match(/^id = "([^"]+)"/m)?.[1];
      const name = text.match(/^name = "([^"]+)"/m)?.[1];
      if (!id || !name) throw new Error(`${f} has no id or name`);
      return { id, name };
    });
}

describe("File › New Project…", () => {
  it("validates the folder name", () => {
    expect(projectNameError("demo")).toBeNull();
    expect(projectNameError("  ")).toBe("Enter a project name");
    expect(projectNameError("a/b")).not.toBeNull();
    expect(projectNameError("..")).not.toBeNull();
  });

  it("joins the location and name with the location's separator", () => {
    expect(joinPath("/Users/me/Projects", " demo ")).toBe("/Users/me/Projects/demo");
    expect(joinPath("/Users/me/", "demo")).toBe("/Users/me/demo");
    expect(joinPath("C:\\Users\\me", "demo")).toBe("C:\\Users\\me\\demo");
    expect(joinRelative("C:\\Users\\me\\demo", "src/main.rs")).toBe("C:\\Users\\me\\demo\\src\\main.rs");
    expect(joinRelative("/work/demo", "src/main.rs")).toBe("/work/demo/src/main.rs");
  });

  it("names packages so they are safe in manifests and source", () => {
    expect(projectNames("My App")).toMatchObject({ slug: "my-app", snake: "my_app", pascal: "MyApp" });
    expect(projectNames("123")).toMatchObject({ slug: "app-123", snake: "app_123" });
    expect(projectNames("class").snake).toBe("class_app");
  });

  it("gives every language a non-empty starter that follows that ecosystem", () => {
    for (const kind of PROJECT_KINDS) {
      const files = starterFiles(kind.id, "My App");
      if (kind.id === "empty") {
        expect(files).toEqual([]);
        continue;
      }
      expect(files.length, kind.id).toBeGreaterThan(0);
      const paths = new Set<string>();
      for (const starter of files) {
        expect(starter.path, kind.id).not.toMatch(/^[\\/]/);
        expect(starter.path, kind.id).not.toContain("..");
        expect(starter.path, kind.id).not.toContain("\\");
        expect(paths.has(starter.path), `${kind.id} ${starter.path}`).toBe(false);
        paths.add(starter.path);
        expect(starter.contents.endsWith("\n"), starter.path).toBe(true);
        if (!starter.path.endsWith(".gitkeep")) expect(starter.contents.trim().length, starter.path).toBeGreaterThan(0);
      }
    }
    const rust = starterFiles("rust", "demo");
    expect(rust.find((f) => f.path === "Cargo.toml")?.contents).toContain('edition = "2024"');
    expect(rust.find((f) => f.path === "src/main.rs")?.contents).toContain("fn main()");
    expect(
      starterFiles("python", "demo").some((f) => f.path === "pyproject.toml" && f.contents.includes("[project]")),
    ).toBe(true);
    expect(
      starterFiles("java", "demo").some(
        (f) => f.path.startsWith("src/main/java/") && f.contents.includes("package com.example;"),
      ),
    ).toBe(true);
    expect(starterFiles("go", "demo").find((f) => f.path === "go.mod")?.contents).toContain("module example.com/demo");
    expect(starterFiles("typescript", "demo").find((f) => f.path === "tsconfig.json")?.contents).toContain(
      '"strict": true',
    );
    expect(starterFiles("csharp", "demo").some((f) => f.contents.includes('Sdk="Microsoft.NET.Sdk"'))).toBe(true);
    expect(starterFiles("cpp", "demo").some((f) => f.contents.includes("CMAKE_CXX_STANDARD 17"))).toBe(true);
    expect(starterFiles("php", "demo").find((f) => f.path === "composer.json")?.contents).toContain('"psr-4"');
    const frameworks = ["laravel", "symfony", "codeigniter", "cakephp", "yii", "laminas", "slim", "drupal", "nette"];
    for (const id of frameworks) {
      const composer = starterFiles(id, "demo").find((f) => f.path === "composer.json");
      expect(composer, id).toBeTruthy();
      expect(() => JSON.parse(composer?.contents ?? ""), id).not.toThrow();
    }
    expect(starterFiles("laravel", "demo").find((f) => f.path === "composer.json")?.contents).toContain(
      '"laravel/framework": "^13.0"',
    );
    expect(starterFiles("laravel", "demo").find((f) => f.path === "artisan")?.contents).toContain("handleCommand");
    expect(starterFiles("symfony", "demo").find((f) => f.path === "composer.json")?.contents).toContain(
      "symfony/framework-bundle",
    );
    expect(
      starterFiles("codeigniter", "demo").some((f) => f.path === "spark" && f.contents.includes("bootSpark")),
    ).toBe(true);
    expect(starterFiles("wordpress", "demo").find((f) => f.path === "style.css")?.contents).toContain("Theme Name:");
    expect(starterFiles("wordpress", "demo").find((f) => f.path === "theme.json")?.contents).toContain('"version": 3');
    expect(
      starterFiles("wordpress-plugin", "My Plugin").some((f) => f.contents.includes("Plugin Name: My Plugin")),
    ).toBe(true);
    expect(
      JSON.parse(starterFiles("drupal", "demo").find((f) => f.path === "composer.json")?.contents ?? ""),
    ).toMatchObject({ extra: { "installer-paths": { "web/modules/contrib/{$name}": ["type:drupal-module"] } } });
    const make = starterFiles("objective-c", "demo").find((f) => f.path === "Makefile")?.contents ?? "";
    expect(make.split("\n").some((line) => line.startsWith("\t"))).toBe(true);
  });

  it("lists every language, aligned under a group, with its file-type icon", () => {
    const defined = definedLanguages();
    const kinds = PROJECT_KINDS.filter((k) => k.id !== "empty");
    const byId = new Map(kinds.map((k) => [k.id, k]));
    expect(new Set(kinds.map((k) => k.id)).size).toBe(kinds.length);
    for (const language of defined) expect(byId.get(language.id)?.name, language.id).toBe(language.name);
    const groups = groupedProjectKinds();
    expect(groups[0]?.name).toBe("General");
    expect(groups[0]?.kinds.map((k) => k.id)).toEqual(["php", "empty"]);
    expect(groups.map((group) => group.name)).toContain("PHP specific");
    expect(groups.find((group) => group.name === "PHP specific")?.kinds.map((kind) => kind.id)).toContain("laravel");
    expect(
      groups
        .find((group) => group.name === "JavaScript")
        ?.kinds.map((kind) => kind.id)
        .slice(0, 4),
    ).toEqual(["nextjs", "nuxt", "react", "vuejs"]);
    for (const name of ["Python", "Ruby", "Go", "Java", "Kotlin", ".NET", "Rust", "Elixir", "Dart", "Scala"]) {
      expect(
        groups.map((group) => group.name),
        name,
      ).toContain(name);
    }
    for (const group of groups) {
      expect(group.kinds.length).toBeGreaterThan(0);
      for (const kind of group.kinds) {
        expect(kind.group).toBe(group.name);
        const icon = projectKindIcon(kind);
        expect(icon, kind.id).not.toBe("file-unknown");
        expect(icon, kind.id).not.toBe("file-code");
        if (kind.icon) expect(icon).toBe(kind.icon);
        else if (kind.file) expect(fileIconName(kind.file)).toBe(icon);
      }
    }
    expect(projectKindIcon(PROJECT_KINDS.find((kind) => kind.id === "laravel")!)).toBe("proj-laravel");
    expect(projectKindIcon(PROJECT_KINDS.find((kind) => kind.id === "symfony")!)).toBe("proj-symfony");
    expect(projectKindIcon(PROJECT_KINDS.find((kind) => kind.id === "wordpress-plugin")!)).toBe("proj-wordpress");
    expect(projectKindIcon(PROJECT_KINDS.find((kind) => kind.id === "vuejs")!)).toBe("file-vue");
    const starters: [string, string, string][] = [
      ["nextjs", "app/page.tsx", '"next":'],
      ["nuxt", "app/app.vue", '"nuxt":'],
      ["react", "src/App.tsx", '"react":'],
      ["vuejs", "src/App.vue", '"vue":'],
    ];
    for (const [id, entry, dep] of starters) {
      const files = starterFiles(id, "demo");
      expect(
        files.some((file) => file.path === entry),
        id,
      ).toBe(true);
      expect(files.find((file) => file.path === "package.json")?.contents, id).toContain(dep);
      expect(files.find((file) => file.path === "package.json")?.contents, id).toMatch(/"dev":/);
    }
    expect(starterFiles("django", "demo").some((file) => file.path === "manage.py")).toBe(true);
    expect(starterFiles("flask", "demo").some((file) => file.contents.includes("Flask"))).toBe(true);
    expect(starterFiles("fastapi", "demo").some((file) => file.contents.includes("FastAPI"))).toBe(true);
    expect(starterFiles("rails", "demo").some((file) => file.contents.includes('gem "rails"'))).toBe(true);
    expect(starterFiles("gin", "demo").find((file) => file.path === "go.mod")?.contents).toContain(
      "github.com/gin-gonic/gin",
    );
    expect(starterFiles("goravel", "demo").find((file) => file.path === "go.mod")?.contents).toContain(
      "github.com/goravel/framework v1.18.0",
    );
    expect(starterFiles("goravel", "demo").some((file) => file.path === "routes/web.go")).toBe(true);
    expect(starterFiles("spring", "demo").some((file) => file.contents.includes("spring-boot-starter-web"))).toBe(true);
    expect(starterFiles("ktor", "demo").some((file) => file.contents.includes("ktor-server-netty"))).toBe(true);
    expect(starterFiles("aspnet", "demo").some((file) => file.contents.includes("Microsoft.NET.Sdk.Web"))).toBe(true);
    expect(starterFiles("axum", "demo").some((file) => file.contents.includes("axum"))).toBe(true);
    expect(starterFiles("phoenix", "demo").some((file) => file.contents.includes(":phoenix"))).toBe(true);
    expect(starterFiles("flutter", "demo").some((file) => file.path === "lib/main.dart")).toBe(true);
  });
});

describe("Manage IDE Settings › Export Settings…", () => {
  it("exports templates, macros and layouts, not per-project state", () => {
    const data: Record<string, string> = {
      "openidea.liveTemplates.v1": "[]",
      "openidea.macros.v1": "{}",
      "openidea.toolWindowLayouts.v1": "{}",
      "openidea.runAnything.history.v1:/p": "[]",
    };
    const keys = Object.keys(data);
    const storage = {
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
      getItem: (k: string) => data[k] ?? null,
    };
    expect(Object.keys(exportedStorage(storage)).sort()).toEqual([
      "openidea.liveTemplates.v1",
      "openidea.macros.v1",
      "openidea.toolWindowLayouts.v1",
    ]);
  });
});
