import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { RootFolder } from "@/platform/languageSettings";
import { gotoTestOrSubject, testDirectoryFor, type ChooserItem, type TestNavDeps } from "./gotoTest";

const root = (path: string, kind: RootFolder["kind"]): RootFolder => ({ path, kind, detectedFrom: "pom.xml" });
const ROOTS = [root("src/main/java", "source"), root("src/test/java", "test")];

function deps(files: string[], roots = ROOTS) {
  const chosen: { title: string; items: ChooserItem[] }[] = [];
  const d: TestNavDeps & { chosen: typeof chosen } = {
    chosen,
    projectRoot: () => "/p",
    roots: () => roots,
    findByName: async (name) => files.filter((f) => f.endsWith(`/${name}`)),
    open: vi.fn(async () => {}),
    choose: (title, items) => void chosen.push({ title, items }),
    hint: vi.fn(),
    createTest: vi.fn(),
    createRustTestModule: vi.fn(),
  };
  return d;
}

beforeEach(() => {
  useProject.setState({
    project: { name: "p", root: "/p", trusted: true, isGit: false, settings: {} } as never,
    settings: {} as never,
  });
});

describe("Go to Test / Test Subject", () => {
  it("opens the only test of a class", async () => {
    const d = deps(["/p/src/main/java/a/Foo.java", "/p/src/test/java/a/FooTest.java"]);
    await gotoTestOrSubject("/p/src/main/java/a/Foo.java", "", d);
    expect(d.open).toHaveBeenCalledWith("/p/src/test/java/a/FooTest.java");
  });

  it("goes back from a test to its subject", async () => {
    const d = deps(["/p/src/main/java/a/Foo.java", "/p/src/test/java/a/FooTest.java"]);
    await gotoTestOrSubject("/p/src/test/java/a/FooTest.java", "", d);
    expect(d.open).toHaveBeenCalledWith("/p/src/main/java/a/Foo.java");
  });

  it("shows a chooser with Create New Test… for several tests, mirrored package first", async () => {
    const d = deps([
      "/p/src/test/java/b/FooTest.java",
      "/p/src/test/java/a/FooTests.java",
      "/p/src/main/java/a/Foo.java",
    ]);
    await gotoTestOrSubject("/p/src/main/java/a/Foo.java", "", d);
    expect(d.chosen[0]!.title).toBe("Choose Test for Foo (2 found)");
    expect(d.chosen[0]!.items.map((i) => i.label)).toEqual(["Create New Test…", "FooTests.java", "FooTest.java"]);
  });

  it("offers Create New Test… in the mirrored test package when there is none", async () => {
    const d = deps(["/p/src/main/java/a/Foo.java"]);
    await gotoTestOrSubject("/p/src/main/java/a/Foo.java", "", d);
    expect(d.chosen[0]!.items.map((i) => i.label)).toEqual(["Create New Test…"]);
    await d.chosen[0]!.items[0]!.run();
    expect(d.createTest).toHaveBeenCalledWith({
      directory: "/p/src/test/java/a",
      name: "FooTest",
      extension: "java",
      subject: "Foo.java",
    });
  });

  it("does not take a non-test file of a test-like name as a test", async () => {
    const d = deps(
      ["/p/src/main/java/a/Foo.java", "/p/src/main/java/a/FooTests.java"],
      [root("src/main/java", "source")],
    );
    // FooTests.java is a test by name, wherever it is.
    await gotoTestOrSubject("/p/src/main/java/a/Foo.java", "", d);
    expect(d.open).toHaveBeenCalledWith("/p/src/main/java/a/FooTests.java");
  });

  it("Go / Python / TS conventions, next to the file", async () => {
    const d = deps(["/p/pkg/foo.go", "/p/pkg/foo_test.go", "/p/m/test_bar.py", "/p/web/x.spec.ts"], []);
    await gotoTestOrSubject("/p/pkg/foo.go", "", d);
    expect(d.open).toHaveBeenLastCalledWith("/p/pkg/foo_test.go");
    await gotoTestOrSubject("/p/m/bar.py", "", d);
    expect(d.open).toHaveBeenLastCalledWith("/p/m/test_bar.py");
    await gotoTestOrSubject("/p/web/x.ts", "", d);
    expect(d.open).toHaveBeenLastCalledWith("/p/web/x.spec.ts");
  });

  it("Rust: the in-file test module and integration tests", async () => {
    const text = "pub fn lex() {}\n#[cfg(test)]\nmod tests {}\n";
    const d = deps(["/p/src/lexer.rs", "/p/tests/lexer.rs"], []);
    await gotoTestOrSubject("/p/src/lexer.rs", text, d);
    expect(d.chosen[0]!.items.map((i) => i.label)).toEqual(["Create New Test…", "mod tests", "lexer.rs"]);
    await d.chosen[0]!.items[1]!.run();
    expect(d.open).toHaveBeenCalledWith("/p/src/lexer.rs", text.indexOf("#[cfg"));
    await d.chosen[0]!.items[0]!.run();
    expect(d.createRustTestModule).toHaveBeenCalled();
    await gotoTestOrSubject("/p/tests/lexer.rs", "", d);
    expect(d.open).toHaveBeenLastCalledWith("/p/src/lexer.rs");
  });

  it("hints when a test has no subject", async () => {
    const d = deps(["/p/src/test/java/a/FooTest.java"]);
    await gotoTestOrSubject("/p/src/test/java/a/FooTest.java", "", d);
    expect(d.hint).toHaveBeenCalledWith("No test subject found");
  });

  it("puts new tests next to the file without source / test roots", () => {
    expect(testDirectoryFor("/p/pkg/foo.go", "/p", [])).toBe("/p/pkg");
    expect(testDirectoryFor("/p/src/main/java/Foo.java", "/p", ROOTS)).toBe("/p/src/test/java");
  });
});
