import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_COLORS,
  fileColorCss,
  fileColorOf,
  ownFileColor,
  validateFileColors,
  withOwnFileColor,
} from "./fileColors";
import { useProject } from "./project";
import { projectModules } from "./projectRoots";
import { filePatternRegExp, inScope, parseScope, scopeError, type ScopeContext } from "./scopes";

const ctx = (scopes: ScopeContext["scopes"] = [], extra: Partial<ScopeContext> = {}): ScopeContext => ({
  roots: [
    { path: "src/test", kind: "test" },
    { path: "build", kind: "excluded" },
  ] as never,
  modules: [
    { name: "p", path: "" },
    { name: "web", path: "web" },
  ],
  scopes,
  ...extra,
});

beforeEach(() => {
  useProject.setState({ project: { name: "p", root: "/p", trusted: true, settings: {} } as never });
});

describe("file patterns", () => {
  const m = (pattern: string, path: string) => filePatternRegExp(pattern).test(path);

  it("reads * within a name, ** and a trailing * as one name, // as any folders", () => {
    expect(m("src/*", "src/a.ts")).toBe(true);
    expect(m("src/*", "src/a/b.ts")).toBe(false);
    // A `*` followed by more of the name matches across folders.
    expect(m("src/*.ts", "src/a/b.ts")).toBe(true);
    expect(m("src/**.ts", "src/a/b.ts")).toBe(false);
    expect(m("src//*", "src/a/b/c.ts")).toBe(true);
    expect(m("src//*", "lib/a.ts")).toBe(false);
    expect(m("*.md", "README.md")).toBe(true);
    expect(m("*.md", "README.mdx")).toBe(false);
    // Folders end in `/`.
    expect(m("src//*", "src/a/")).toBe(true);
  });
});

describe("scope expressions", () => {
  it("combines file patterns with !, && and || in precedence order", () => {
    const scope = { name: "TS", pattern: "file:src//*.ts && !file:*.test.ts || file:README.md" };
    const c = ctx([scope]);
    expect(inScope("TS", "/p/src/a/b.ts", c)).toBe(true);
    expect(inScope("TS", "/p/src/a/b.test.ts", c)).toBe(false);
    expect(inScope("TS", "/p/README.md", c)).toBe(true);
    expect(inScope("TS", "/elsewhere/src/a.ts", c)).toBe(false);
  });

  it("limits a pattern to a module", () => {
    const c = ctx([{ name: "Web", pattern: "file[web]:*.ts" }]);
    expect(inScope("Web", "/p/web/app.ts", c)).toBe(true);
    expect(inScope("Web", "/p/src/app.ts", c)).toBe(false);
  });

  it("matches absolute module paths on POSIX and Windows drives", () => {
    useProject.setState({
      project: {
        name: "ws",
        root: "/ws",
        trusted: true,
        settings: {},
        workspace: { version: 1, name: "ws", projects: ["/ws/app", "/ws/svc"] },
      } as never,
    });
    const posix = ctx([{ name: "Svc", pattern: "file[svc]:*.java" }], {
      modules: [
        { name: "app", path: "/ws/app" },
        { name: "svc", path: "/ws/svc" },
      ],
    });
    expect(inScope("Svc", "/ws/svc/src/App.java", posix)).toBe(true);
    expect(inScope("Svc", "/ws/app/src/App.java", posix)).toBe(false);

    useProject.setState({
      project: {
        name: "ws",
        root: "C:/ws",
        trusted: true,
        settings: {},
        workspace: { version: 1, name: "ws", projects: ["C:/ws/app", "C:/ws/svc"] },
      } as never,
    });
    const win = ctx([{ name: "Svc", pattern: "file[svc]:*.java" }], {
      modules: [
        { name: "app", path: "C:/ws/app" },
        { name: "svc", path: "C:/ws/svc" },
      ],
    });
    expect(inScope("Svc", "C:/ws/svc/src/App.java", win)).toBe(true);
    expect(inScope("Svc", "C:/ws/app/src/App.java", win)).toBe(false);
  });

  it("keeps subproject and root module scopes matching when synced from a subproject folder", () => {
    // Opened at `/checkout/composite/app` while Gradle reports ancestor `composite` as plain `Gradle`,
    // in-project `app` as `Gradle`, child `app:lib` as `lib/Gradle`, and sibling included build `svc`.
    useProject.setState({
      project: { name: "app", root: "/checkout/composite/app", trusted: true, settings: {} } as never,
    });
    const modules = projectModules(
      [
        { path: "checkout/composite/src/main/java", kind: "source", detectedFrom: "Gradle" },
        { path: "src/main/java", kind: "source", detectedFrom: "Gradle" },
        { path: "lib/src/main/java", kind: "source", detectedFrom: "lib/Gradle" },
        { path: "checkout/svc/src/main/java", kind: "source", detectedFrom: "/checkout/svc/Gradle" },
      ],
      "app",
    );
    expect(modules).toEqual([
      { path: "", name: "app" },
      { path: "/checkout/svc", name: "svc" },
      { path: "lib", name: "lib" },
    ]);
    const c = ctx(
      [
        { name: "App", pattern: "file[app]:*.java" },
        { name: "Lib", pattern: "file[lib]:*.java" },
      ],
      { modules },
    );
    expect(inScope("Lib", "/checkout/composite/app/lib/src/main/java/A.java", c)).toBe(true);
    expect(inScope("App", "/checkout/composite/app/src/main/java/B.java", c)).toBe(true);
    expect(inScope("Lib", "/checkout/composite/app/src/main/java/B.java", c)).toBe(false);
    expect(inScope("App", "/checkout/composite/app/lib/src/main/java/A.java", c)).toBe(false);
  });

  it("reports where a pattern goes wrong", () => {
    expect(scopeError("file:a && (file:b")).toEqual({ message: "')' expected", at: 17 });
    expect(scopeError("src/*")).toEqual({ message: "'file:' expected", at: 0 });
    expect(scopeError("file:")).toEqual({ message: "Pattern expected", at: 5 });
    expect(scopeError("file:a)")).toEqual({ message: "Unexpected text", at: 6 });
    expect(() => parseScope("(file:a || file:b) && !file:c")).not.toThrow();
  });

  it("knows the built-in scopes", () => {
    const c = ctx([], { ownFolders: ["/scratches"] });
    expect(inScope("Tests", "/p/src/test/A.java", c)).toBe(true);
    expect(inScope("Production", "/p/src/main/A.java", c)).toBe(true);
    expect(inScope("Project Files", "/p/build/out.class", c)).toBe(false);
    expect(inScope("Non-Project Files", "/lib/rt.jar", c)).toBe(true);
    expect(inScope("Non-Project Files", "/scratches/a.sql", c)).toBe(false);
    expect(inScope("Non-Project Files", "/p/a.ts", c)).toBe(false);
  });
});

describe("file colors", () => {
  it("colours tests green and non-project files yellow by default; the first matching scope wins", () => {
    const c = ctx([{ name: "Docs", pattern: "file:*.md" }]);
    expect(fileColorOf("/p/src/test/A.java", DEFAULT_FILE_COLORS, c)).toBe("var(--file-color-green)");
    expect(fileColorOf("/lib/A.java", DEFAULT_FILE_COLORS, c)).toBe("var(--file-color-yellow)");
    expect(fileColorOf("/p/src/A.java", DEFAULT_FILE_COLORS, c)).toBeUndefined();
    const s = validateFileColors({
      colors: [
        { scope: "Docs", color: "#112233" },
        { scope: "Project Files", color: "Blue" },
      ],
    });
    expect(fileColorOf("/p/a.md", s, c)).toBe("#112233");
    expect(fileColorOf("/p/a.ts", s, c)).toBe("var(--file-color-blue)");
    expect(fileColorOf("/p/a.ts", { ...s, enabled: false }, c)).toBeUndefined();
  });

  it("ignores colours it can't draw", () => {
    expect(fileColorCss("red; background: url(x)")).toBeUndefined();
    expect(fileColorCss("Gray")).toBe("var(--file-color-gray)");
  });
});

describe("a file or folder's own colour", () => {
  it("adds a scope of the path ahead of the other colours, and removes both again", () => {
    const set = withOwnFileColor({}, "src/api", true, "rose")!;
    expect(set.scopes).toEqual([{ name: "src/api", pattern: "file:src/api//*" }]);
    expect(set.fileColors.colors[0]).toEqual({ scope: "src/api", color: "rose" });
    expect(set.fileColors.colors.slice(1)).toEqual(DEFAULT_FILE_COLORS.colors);
    expect(ownFileColor("src/api", true, set)).toBe("rose");
    const c = ctx(set.scopes);
    // Everything in the folder, including its tests, takes the folder's colour.
    expect(fileColorOf("/p/src/api/x_test.go", set.fileColors, c)).toBe("var(--file-color-rose)");
    expect(fileColorOf("/p/src/api", set.fileColors, c, true)).toBe("var(--file-color-rose)");
    expect(fileColorOf("/p/src/apix/a.go", set.fileColors, c)).toBeUndefined();

    const recolored = withOwnFileColor(set, "src/api", true, "blue")!;
    expect(recolored.fileColors.colors.filter((x) => x.scope === "src/api")).toHaveLength(1);
    const cleared = withOwnFileColor(set, "src/api", true, null)!;
    expect(cleared.scopes).toEqual([]);
    expect(cleared.fileColors.colors).toEqual(DEFAULT_FILE_COLORS.colors);
  });

  it("is not offered for paths a pattern can't name", () => {
    expect(withOwnFileColor({}, "my docs", true, "blue")).toBeNull();
    expect(withOwnFileColor({}, "", true, "blue")).toBeNull();
  });
});
