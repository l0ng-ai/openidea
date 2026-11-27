import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ startRun: vi.fn() }));
import { compileErrorCollector } from "./buildUpdate";

describe("compileErrorCollector", () => {
  it("keeps the compiler errors of Maven, javac and Kotlin output without colour codes", () => {
    const errors = compileErrorCollector();
    errors.add("[INFO] Compiling 3 source files with javac [debug release 17] to target/classes");
    errors.add("\u001b[1;31m[ERROR] /p/src/main/java/a/XxxServiceImpl.java:[1,1] 非法字符: '\\ufeff'\u001b[m");
    errors.add("[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile");
    // Maven's failure summary repeats the error.
    errors.add("[ERROR] /p/src/main/java/a/XxxServiceImpl.java:[1,1] 非法字符: '\\ufeff'");
    errors.add("/p/src/main/java/a/B.java:12: error: ';' expected\n        int x = 1\n");
    errors.add("e: file:///p/src/main/kotlin/a/C.kt:3:5 Unresolved reference: foo");
    expect(errors.lines()).toEqual([
      "[ERROR] /p/src/main/java/a/XxxServiceImpl.java:[1,1] 非法字符: '\\ufeff'",
      "/p/src/main/java/a/B.java:12: error: ';' expected",
      "e: file:///p/src/main/kotlin/a/C.kt:3:5 Unresolved reference: foo",
    ]);
  });

  it("keeps the first ten and counts the rest", () => {
    const errors = compileErrorCollector();
    for (let i = 1; i <= 13; i++) errors.add(`[ERROR] /p/A.java:[${i},1] cannot find symbol`);
    const lines = errors.lines();
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe("[ERROR] /p/A.java:[10,1] cannot find symbol");
    expect(lines[10]).toBe("… and 3 more");
  });
});
