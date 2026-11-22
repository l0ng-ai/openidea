import { describe, expect, it } from "vitest";
import { disambiguateTitles } from "./tabTitles";

describe("disambiguateTitles", () => {
  it("leaves unique names alone", () => {
    expect(disambiguateTitles(["/p/a/main.rs", "/p/b/lib.rs"]).size).toBe(0);
  });

  it("uses the nearest distinguishing directory", () => {
    const m = disambiguateTitles(["/p/crates/ide-lsp/src/lib.rs", "/p/crates/ide-vcs/src/lib.rs", "/p/src/main.rs"]);
    expect(m.get("/p/crates/ide-lsp/src/lib.rs")).toBe("ide-lsp");
    expect(m.get("/p/crates/ide-vcs/src/lib.rs")).toBe("ide-vcs");
    expect(m.has("/p/src/main.rs")).toBe(false);
  });

  it("uses the parent directly when it differs", () => {
    const m = disambiguateTitles(["/p/a/index.ts", "/p/b/index.ts"]);
    expect(m.get("/p/a/index.ts")).toBe("a");
    expect(m.get("/p/b/index.ts")).toBe("b");
  });

  it("falls back to a parent path when no single directory is unique", () => {
    const m = disambiguateTitles(["/r/a/b/f.ts", "/r/c/b/f.ts", "/r/a/d/f.ts"]);
    expect(m.get("/r/a/b/f.ts")).toBe("a/b");
    expect(m.get("/r/c/b/f.ts")).toBe("c");
    expect(m.get("/r/a/d/f.ts")).toBe("d");
  });

  it("distinguishes directory names that occur at different depths", () => {
    const paths = ["/r/prod/shared/f.ts", "/r/shared/prod/f.ts", "/r/test/shared/f.ts"];
    const labels = disambiguateTitles(paths);
    expect(paths.map((path) => labels.get(path))).toEqual(["prod/shared", "shared/prod", "test"]);
  });

  it("ignores duplicates of the same path", () => {
    expect(disambiguateTitles(["/p/a/x.ts", "/p/a/x.ts"]).size).toBe(0);
  });
});
