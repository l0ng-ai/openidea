import { describe, expect, it } from "vitest";
import { findOutputLinks, joinPath, type OutputLink } from "./links";

function files(text: string) {
  return findOutputLinks(text)
    .filter((l): l is Extract<OutputLink, { kind: "file" }> => l.kind === "file")
    .map((l) => ({ ...l.target, text: text.slice(l.start, l.end) }));
}

describe("findOutputLinks", () => {
  it("rust diagnostics and panics", () => {
    expect(files("  --> src/main.rs:10:5")).toEqual([
      { path: "src/main.rs", line: 10, col: 5, resolve: "path", text: "src/main.rs:10:5" },
    ]);
    expect(files("thread 'main' panicked at crates/app/src/lib.rs:42:9:")[0]).toMatchObject({
      path: "crates/app/src/lib.rs",
      line: 42,
      col: 9,
    });
  });

  it("node / v8 stack frames", () => {
    expect(files("    at foo (src/server.ts:3:7)")).toEqual([
      { path: "src/server.ts", line: 3, col: 7, resolve: "path", text: "src/server.ts:3:7" },
    ]);
    expect(files("    at file:///Users/me/app/index.mjs:12:1")[0]).toMatchObject({
      path: "/Users/me/app/index.mjs",
      line: 12,
    });
    expect(files("    at Object.<anonymous> (/abs/dir/x.js:1:2)")[0]).toMatchObject({ path: "/abs/dir/x.js" });
  });

  it("python tracebacks", () => {
    const [link] = files('  File "app/main.py", line 3, in <module>');
    expect(link).toEqual({ path: "app/main.py", line: 3, resolve: "path", text: 'File "app/main.py", line 3' });
  });

  it("java / kotlin frames resolve by fully qualified class name", () => {
    const [link] = files("\tat com.acme.orders.OrderController.list(OrderController.kt:22)");
    expect(link).toEqual({
      path: "com/acme/orders/OrderController.kt",
      line: 22,
      resolve: "name",
      className: "com.acme.orders.OrderController",
      text: "OrderController.kt:22",
    });
    // Nested classes and lambdas live in the outer class's file; JDK module prefixes are skipped.
    expect(files("\tat com.acme.Outer$Inner.lambda$run$0(Outer.java:7)")[0]).toMatchObject({
      path: "com/acme/Outer.java",
      className: "com.acme.Outer$Inner",
    });
    expect(files("\tat java.base/java.util.ArrayList.get(ArrayList.java:427)")[0]).toMatchObject({
      path: "java/util/ArrayList.java",
      className: "java.util.ArrayList",
    });
    // The default package, and a bare `(File.java:3)` without a frame.
    expect(files("\tat Main.main(Main.java:3)")[0]).toMatchObject({ path: "Main.java", className: "Main" });
    expect(files("(Main.java:3)")[0]).toEqual({ path: "Main.java", line: 3, resolve: "name", text: "Main.java:3" });
  });

  it("go and generic path:line", () => {
    expect(files("    math_test.go:12: expected 1")[0]).toMatchObject({ path: "math_test.go", line: 12 });
    expect(files("./cmd/server/main.go:8:2: undefined: x")[0]).toMatchObject({
      path: "./cmd/server/main.go",
      line: 8,
      col: 2,
    });
    expect(files("src/App.tsx(14,3): error TS2322")[0]).toMatchObject({ path: "src/App.tsx", line: 14, col: 3 });
    // Go module cache paths with @version and stack frames
    expect(files("        /Users/user/go/pkg/mod/github.com/spf13/cobra@v1.10.2/command.go:1071")[0]).toMatchObject({
      path: "/Users/user/go/pkg/mod/github.com/spf13/cobra@v1.10.2/command.go",
      line: 1071,
    });
    // Go stack frames with trailing colon
    expect(files("        /Users/user/projects/demo/pkg/api/server.go:42:")[0]).toMatchObject({
      path: "/Users/user/projects/demo/pkg/api/server.go",
      line: 42,
    });
    // Relative paths in loggers (e.g. zap/zerolog/slog)
    expect(files("2026-01-01T12:00:00.000+0000\tDEBUG\tpkg/store/db.go:15\tfailed to connect")[0]).toMatchObject({
      path: "pkg/store/db.go",
      line: 15,
    });
  });

  it("maven diagnostics [ERROR] path:[line,col]", () => {
    expect(files("[ERROR] /p/src/main/java/a/A.java:[12,5] cannot find symbol")[0]).toEqual({
      path: "/p/src/main/java/a/A.java",
      line: 12,
      col: 5,
      resolve: "path",
      text: "/p/src/main/java/a/A.java:[12,5]",
    });
    expect(files("[WARNING] src/main/java/B.java:[3,8] [deprecation] old() has been deprecated")[0]).toMatchObject({
      path: "src/main/java/B.java",
      line: 3,
      col: 8,
    });
    expect(files("[ERROR] C:\\proj\\A.java:[7,1] error: x")[0]).toMatchObject({
      path: "C:\\proj\\A.java",
      line: 7,
      col: 1,
    });
  });

  it("URLs, trimming trailing punctuation", () => {
    const links = findOutputLinks("Listening on http://localhost:8080/api. (see https://x.dev/a_(b))");
    expect(links.filter((l) => l.kind === "url").map((l) => (l.kind === "url" ? l.url : ""))).toEqual([
      "http://localhost:8080/api",
      "https://x.dev/a_(b)",
    ]);
  });

  it("doesn't link URL ports or versions as files", () => {
    expect(files("Started at http://127.0.0.1:3000")).toEqual([]);
    expect(files("version 1.2.3:4")).toEqual([]);
    expect(files("plain text 12:30")).toEqual([]);
  });

  it("returns links sorted and non-overlapping", () => {
    const links = findOutputLinks("a.rs:1 then b.ts:2:3");
    expect(links.map((l) => l.start)).toEqual([0, 12]);
  });
});

describe("joinPath", () => {
  it("joins and normalises", () => {
    expect(joinPath("/p/app", "src/main.rs")).toBe("/p/app/src/main.rs");
    expect(joinPath("/p/app", "./a/../b.ts")).toBe("/p/app/b.ts");
    expect(joinPath("/p/app", "/abs/x.py")).toBe("/abs/x.py");
    expect(joinPath("/p/app/", "file:///abs/y.js")).toBe("/abs/y.js");
  });
});
