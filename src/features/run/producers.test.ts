import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import {
  innermostTarget,
  nodeTypeStripping,
  OPTIMISTIC,
  produceContext,
  produceContextChoices,
  produceDirectory,
  produceFile,
  shebang,
  shellWord,
  fileTargets,
  type ContextInput,
  type LocatedTool,
  type ToolEnv,
} from "./producers";

const ROOT = "/work/app";
const SCRATCH = "/Users/me/Library/Application Support/ai.l0ng.openidea/scratches";

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: over.kind,
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...over,
});

/** Tools at `/bin/<name>` with optional versions; names not listed are not installed. */
function env(tools: Record<string, string | null>, extra: Partial<ToolEnv> = {}): ToolEnv {
  return {
    tool: (n): LocatedTool | null => (n in tools ? { path: `/bin/${n}`, version: tools[n] ?? null } : null),
    compileDir: "/tmp/openidea-run",
    ...extra,
  };
}

const ALL = env({
  node: "24.11.0",
  python3: null,
  bash: null,
  zsh: null,
  sh: null,
  ruby: null,
  php: null,
  perl: null,
  lua: null,
  Rscript: null,
  go: null,
  rustc: "1.85.0",
  java: null,
  kotlin: null,
  swift: null,
  clang: null,
  "clang++": null,
  dart: null,
  elixir: null,
  "scala-cli": null,
  deno: "2.1.0",
  bun: "1.1.0",
});

const scratch = (name: string, content?: string, line?: number): ContextInput => ({
  path: `${SCRATCH}/${name}`,
  root: ROOT,
  configs: [],
  content,
  line,
});

const run = (input: ContextInput, e: ToolEnv = ALL) => {
  const p = produceContext(input, e);
  return p?.config ? { name: p.name, command: p.config.command, args: p.config.args, cwd: p.config.cwd } : p;
};

describe("single-file producers (scratches)", () => {
  it("JavaScript: node <file> from the file's directory, debuggable with js-debug", () => {
    const p = produceContext(scratch("hi.js", "console.log(1)"), ALL)!;
    expect(p.name).toBe("hi.js");
    expect(p.config).toMatchObject({ command: "/bin/node", args: ["hi.js"], cwd: SCRATCH, debugAdapter: "js-debug" });
    expect(p.config!.id).toBe(`context:file:${SCRATCH}/hi.js`);
  });

  it("TypeScript: node type stripping by version, then tsx / ts-node, else what is missing", () => {
    expect(run(scratch("hi.ts"), env({ node: "23.6.0" }))).toMatchObject({ command: "/bin/node", args: ["hi.ts"] });
    expect(run(scratch("hi.ts"), env({ node: "22.18.0" }))).toMatchObject({ args: ["hi.ts"] });
    expect(run(scratch("hi.ts"), env({ node: "22.6.0" }))).toMatchObject({
      args: ["--experimental-strip-types", "hi.ts"],
    });
    expect(run(scratch("hi.ts"), env({ node: "23.5.0" }))).toMatchObject({
      args: ["--experimental-strip-types", "hi.ts"],
    });
    expect(run(scratch("hi.ts"), env({ node: "20.11.0", tsx: null }))).toMatchObject({
      command: "/bin/tsx",
      args: ["hi.ts"],
    });
    expect(run(scratch("hi.ts"), env({ node: "20.11.0", "ts-node": null }))).toMatchObject({ command: "/bin/ts-node" });
    const missing = produceContext(scratch("hi.ts"), env({ node: "20.11.0" }))!;
    expect(missing.name).toBe("hi.ts");
    expect(missing.config).toBeUndefined();
    expect(missing.missing!.body).toMatch(/22\.6\+.*Found Node\.js 20\.11\.0.*npm install -D tsx/);
    expect(produceContext(scratch("hi.js"), env({}))!.missing!.body).toMatch(/Node\.js was not found.*nodejs\.org/);
  });

  it("type stripping versions", () => {
    expect(nodeTypeStripping("22.5.1")).toBeNull();
    expect(nodeTypeStripping("22.6.0")).toBe("flag");
    expect(nodeTypeStripping("22.17.9")).toBe("flag");
    expect(nodeTypeStripping("22.18.0")).toBe("native");
    expect(nodeTypeStripping("23.5.0")).toBe("flag");
    expect(nodeTypeStripping("23.6.0")).toBe("native");
    expect(nodeTypeStripping("v?")).toBeNull();
  });

  it("Deno / Bun projects run JS and TS with their runtime", () => {
    const input: ContextInput = { path: `${ROOT}/scripts/x.ts`, root: ROOT, configs: [] };
    expect(run(input, { ...ALL, deno: true })).toMatchObject({
      command: "/bin/deno",
      args: ["run", "scripts/x.ts"],
      cwd: null,
    });
    expect(produceContext(input, { ...ALL, deno: true })!.config!.debugAdapter).toBe("js-debug");
    expect(run(input, { ...ALL, bun: true })).toMatchObject({ command: "/bin/bun", args: ["run", "scripts/x.ts"] });
    // Bun's inspector is WebKit-only: js-debug can't attach.
    expect(produceContext(input, { ...ALL, bun: true })!.config!.debugAdapter).toBeNull();
    // Not for scratches outside the project.
    expect(run(scratch("x.ts"), { ...ALL, deno: true })).toMatchObject({ command: "/bin/node" });
  });

  it("Python: the interpreter from settings, then the project's, then python3", () => {
    expect(run(scratch("hi.py"), { ...ALL, python: "/work/app/.venv/bin/python" })).toMatchObject({
      command: "/work/app/.venv/bin/python",
      args: ["hi.py"],
      cwd: SCRATCH,
    });
    const venv = [cfg({ id: "python:module:app", kind: "python", command: ".venv/bin/python", args: ["-m", "app"] })];
    expect(run({ ...scratch("hi.py"), configs: venv })).toMatchObject({ command: "/work/app/.venv/bin/python" });
    expect(run({ path: `${ROOT}/tools/gen.py`, root: ROOT, configs: venv })).toMatchObject({
      command: ".venv/bin/python",
      args: ["tools/gen.py"],
      cwd: null,
    });
    expect(produceContext(scratch("hi.py"), ALL)!.config).toMatchObject({
      command: "/bin/python3",
      debugAdapter: "debugpy",
    });
    expect(produceContext(scratch("hi.py"), env({}))!.missing!.title).toBe("Cannot run 'hi.py'");
  });

  it("shell scripts: the shell of the #! line, else by extension; extensionless files by #!", () => {
    expect(run(scratch("a.sh", "#!/usr/bin/env bash\necho hi"))).toMatchObject({
      command: "/bin/bash",
      args: ["a.sh"],
    });
    expect(run(scratch("a.sh", "#!/bin/zsh -f\necho"))).toMatchObject({ command: "/bin/zsh", args: ["-f", "a.sh"] });
    expect(run(scratch("a.sh", "echo"))).toMatchObject({ command: "/bin/sh" });
    expect(run(scratch("a.zsh", "echo"))).toMatchObject({ command: "/bin/zsh" });
    expect(run(scratch("tool", "#!/usr/bin/env ruby\nputs 1"))).toMatchObject({
      name: "tool",
      command: "/bin/ruby",
      args: ["tool"],
    });
    expect(run(scratch("tool", "#!/usr/bin/env -S deno run -A\n"))).toMatchObject({
      command: "/bin/deno",
      args: ["run", "-A", "tool"],
    });
    expect(produceContext(scratch("tool", "#!/usr/bin/env -S deno run -A\n"), ALL)!.config!.debugAdapter).toBe(
      "js-debug",
    );
    expect(run(scratch("tool", "#!/usr/bin/env python3\n"))).toMatchObject({ command: "/bin/python3", args: ["tool"] });
    expect(run(scratch("build.bat"), { ...ALL, windows: true })).toMatchObject({
      command: "cmd.exe",
      args: ["/c", "build.bat"],
      cwd: SCRATCH,
    });
    expect(run({ path: `${ROOT}/scripts/run.cmd`, root: ROOT, configs: [] }, { ...ALL, windows: true })).toMatchObject({
      command: "cmd.exe",
      args: ["/c", "run.cmd"],
      cwd: "scripts",
    });
    expect(produceContext(scratch("build.bat"), ALL)).toBeNull();
    expect(produceContext(scratch("notes", "just text"), ALL)).toBeNull();
    expect(shebang("#!/usr/bin/env node")).toEqual(["node"]);
  });

  it("Ruby, PHP, Perl, Lua, R, Swift, Dart, Elixir, Scala CLI, Kotlin script", () => {
    expect(run(scratch("a.rb"))).toMatchObject({ command: "/bin/ruby", args: ["a.rb"] });
    expect(run(scratch("a.php"))).toMatchObject({ command: "/bin/php", args: ["a.php"] });
    expect(run(scratch("a.pl"))).toMatchObject({ command: "/bin/perl" });
    expect(run(scratch("a.lua"))).toMatchObject({ command: "/bin/lua" });
    expect(run(scratch("a.R"))).toMatchObject({ command: "/bin/Rscript", args: ["a.R"] });
    expect(run(scratch("a.swift"))).toMatchObject({ command: "/bin/swift", args: ["a.swift"] });
    expect(run(scratch("a.dart"))).toMatchObject({ command: "/bin/dart", args: ["run", "a.dart"] });
    expect(run(scratch("a.exs"))).toMatchObject({ command: "/bin/elixir", args: ["a.exs"] });
    expect(run(scratch("a.sc"))).toMatchObject({ command: "/bin/scala-cli", args: ["run", "a.sc"] });
    expect(run(scratch("a.kts"))).toMatchObject({ command: "/bin/kotlin", args: ["a.kts"] });
    expect(run(scratch("a.kts"), env({ kotlinc: null }))).toMatchObject({
      command: "/bin/kotlinc",
      args: ["-script", "a.kts"],
    });
    expect(produceContext(scratch("a.rb"), env({}))!.missing!.body).toMatch(/brew install ruby/);
    expect(produceContext(scratch("build.gradle.kts"), ALL)).toBeNull();
  });

  it("Go: go run <file> for package main outside a module", () => {
    expect(run(scratch("hi.go", "package main\nfunc main() {}"))).toMatchObject({
      command: "/bin/go",
      args: ["run", "hi.go"],
      cwd: SCRATCH,
    });
    expect(produceContext(scratch("lib.go", "package lib"), ALL)).toBeNull();
    expect(produceContext(scratch("hi.go", "package main"), ALL)!.config!.debugAdapter).toBe("delve");
  });

  it("Go: the module's go run for packages in the project", () => {
    const go = [cfg({ id: "go:run", kind: "go", command: "go", args: ["run", "."] })];
    const p = produceContext(
      { path: `${ROOT}/cmd/tool/main.go`, root: ROOT, configs: go, content: "package main\nfunc main() {}" },
      ALL,
    )!;
    expect(p.config).toMatchObject({ args: ["run", "./cmd/tool"] });
  });

  it("Rust: rustc into the compile directory, then the binary; codelldb debugs the binary", () => {
    const p = produceContext(scratch("hihi.rs", 'fn main() {\n  println!("hi");\n}'), ALL)!;
    expect(p.name).toBe("hihi.rs");
    expect(p.config!.cwd).toBe(SCRATCH);
    expect(p.config!.args).toEqual([]);
    expect(p.config!.command).toMatch(
      /^mkdir -p \/tmp\/openidea-run && \/bin\/rustc -g --edition 2021 -o \/tmp\/openidea-run\/hihi-\w+ hihi\.rs && \/tmp\/openidea-run\/hihi-\w+$/,
    );
    expect(p.config!.kind).toBe("rustc");
    expect(p.debug!.build.command).toMatch(/rustc -g .* hihi\.rs$/);
    expect(p.debug!.config).toMatchObject({ kind: "native", debugAdapter: "codelldb", args: [] });
    expect(p.debug!.config.command).toMatch(/^\/tmp\/openidea-run\/hihi-\w+$/);
    expect(produceContext(scratch("hihi.rs", "fn main() {}"), env({}))!.missing!.body).toMatch(/rustup/);
  });

  it("Rust: a test at the caret of a standalone file builds with --test and filters", () => {
    const src = [
      "fn main() {}",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn adds() {",
      "        assert!(true);",
      "    }",
      "}",
    ].join("\n");
    const p = produceContext(scratch("calc.rs", src, 5), ALL)!;
    expect(p).toMatchObject({ name: "tests::adds", scope: "element" });
    expect(p.config!.command).toMatch(
      /rustc -g --edition 2021 --test -o \S+-test calc\.rs && \S+-test tests::adds --exact$/,
    );
    expect(p.config!.isTest).toBe(true);
    // On the module line: the whole module.
    expect(produceContext(scratch("calc.rs", src, 2), ALL)!.config!.command).toMatch(/-test tests::$/);
    // Outside: the file (main).
    expect(produceContext(scratch("calc.rs", src, 0), ALL)!.name).toBe("calc.rs");
  });

  it("Rust in a Cargo project: cargo run --bin / --example, not rustc", () => {
    const cargo = [
      cfg({ id: "cargo:run:server", kind: "cargo", command: "cargo", args: ["run", "--bin", "server"] }),
      cfg({ id: "cargo:test", kind: "cargo", command: "cargo", args: ["test"], isTest: true }),
    ];
    const bin = produceContext(
      { path: `${ROOT}/src/bin/server.rs`, root: ROOT, configs: cargo, content: "fn main() {}" },
      ALL,
    )!;
    expect(bin.config!.id).toBe("cargo:run:server");
    const ex = produceContext(
      { path: `${ROOT}/examples/demo.rs`, root: ROOT, configs: cargo, content: "fn main() {}" },
      ALL,
    )!;
    expect(ex.config).toMatchObject({ args: ["run", "--example", "demo"], name: "Run demo" });
    expect(
      produceContext({ path: `${ROOT}/src/lib.rs`, root: ROOT, configs: cargo, content: "pub fn x() {}" }, ALL),
    ).toBeNull();
    const test = produceContext(
      { path: `${ROOT}/src/lib.rs`, root: ROOT, configs: cargo, content: "#[test]\nfn works() {\n}\n", line: 2 },
      ALL,
    )!;
    expect(test.config).toMatchObject({ command: "cargo", args: ["test", "--", "works", "--exact"], name: "works" });
  });

  it("Java: java <File>.java outside a build project; the Application configuration inside", () => {
    const src = "public class Hi {\n  public static void main(String[] args) {\n    System.out.println(1);\n  }\n}";
    expect(run(scratch("Hi.java", src))).toMatchObject({ command: "/bin/java", args: ["Hi.java"], cwd: SCRATCH });
    expect(produceContext(scratch("Hi.java", src), ALL)!.config!.kind).toBe("java-file");
    expect(produceContext(scratch("Lib.java", "class Lib {}"), ALL)).toBeNull();
    const gradle = [cfg({ id: "gradle:test", kind: "gradle", command: "./gradlew", args: ["test"], isTest: true })];
    const p = produceContext(
      {
        path: `${ROOT}/src/main/java/demo/Hi.java`,
        root: ROOT,
        configs: gradle,
        content: `package demo;\n${src}`,
        line: 3,
      },
      ALL,
    )!;
    expect(p.config).toMatchObject({ kind: "application", name: "Hi" });
    expect(p.config!.args.at(-1)).toBe("demo.Hi");
  });

  describe("Java / Kotlin mains in a build nested in a folder of repositories", () => {
    // RuoYi-Vue-Plus (Maven) next to plus-ui (npm), opened together.
    const boot =
      "package org.dromara;\n\nimport org.springframework.boot.SpringApplication;\n\n@SpringBootApplication\n" +
      "public class DromaraApplication {\n  public static void main(String[] args) {\n" +
      "    SpringApplication.run(DromaraApplication.class, args);\n  }\n}\n";
    const nested = (kind: "maven" | "gradle", dir: string) => [
      cfg({ id: "npm:plus-ui:dev", kind: "npm", command: "npm", args: ["run", "dev"], cwd: "plus-ui" }),
      cfg({ id: `${kind}:test:${dir}`, kind, args: ["test"], cwd: dir, isTest: true }),
    ];
    const at = (path: string, configs: RunConfig[], content = boot, line = 6): ContextInput => ({
      path: `${ROOT}/${path}`,
      root: ROOT,
      configs,
      content,
      line,
    });
    const cases = [
      {
        kind: "maven",
        dir: "RuoYi-Vue-Plus",
        file: "RuoYi-Vue-Plus/ruoyi-admin/src/main/java/org/dromara/DromaraApplication.java",
      },
      {
        kind: "gradle",
        dir: "services/api",
        file: "services/api/app/src/main/java/org/dromara/DromaraApplication.java",
      },
    ] as const;
    for (const { kind, dir, file } of cases) {
      it(`${kind}: the Spring Boot application in its module, from the gutter and from the file`, () => {
        const module = file.slice(0, file.indexOf("/src/"));
        for (const p of [
          produceContext(at(file, nested(kind, dir)), ALL),
          produceFile(at(file, nested(kind, dir)), ALL),
        ]) {
          expect(p!.config).toMatchObject({
            id: `application:${module}:org.dromara.DromaraApplication`,
            kind: "spring-boot",
            name: "DromaraApplication",
            command: "java",
            cwd: module,
          });
          expect(p!.config!.args).toEqual(["-cp", "${classpath}", "org.dromara.DromaraApplication"]);
        }
      });
    }

    it("a file outside every build still runs as a single source file", () => {
      const src = "public class Hi {\n  public static void main(String[] args) {}\n}\n";
      const p = produceContext(at("scripts/Hi.java", nested("maven", "RuoYi-Vue-Plus"), src, 1), ALL)!;
      expect(p.config).toMatchObject({ kind: "java-file", args: ["scripts/Hi.java"] });
    });

    it("Kotlin and test classes use the build that contains them", () => {
      const kt = "package demo\n\nfun main() {\n  println(1)\n}\n";
      const p = produceContext(at("backend/app/src/main/kotlin/demo/App.kt", nested("gradle", "backend"), kt, 3), ALL)!;
      expect(p.config).toMatchObject({ kind: "application", cwd: "backend/app" });
      expect(p.config!.args.at(-1)).toBe("demo.AppKt");
      const test = "package demo;\nclass AppTest {\n  @Test\n  void works() {\n  }\n}\n";
      const t = produceContext(
        at("backend/app/src/test/java/demo/AppTest.java", nested("gradle", "backend"), test, 4),
        ALL,
      )!;
      expect(t.config).toMatchObject({ kind: "gradle", cwd: "backend" });
      expect(t.config!.args).toEqual(["test", "--tests", "demo.AppTest.works"]);
    });
  });

  it("C / C++: compile with debug info into the compile directory", () => {
    const c = produceContext(scratch("a.c", "int main(void) { return 0; }"), ALL)!;
    expect(c.config!.command).toMatch(
      /^mkdir -p \/tmp\/openidea-run && \/bin\/clang -g -o \/tmp\/openidea-run\/a-\w+ a\.c && \/tmp\/openidea-run\/a-\w+$/,
    );
    const cpp = produceContext(scratch("a.cpp", "int main() {}"), env({ "g++": null }))!;
    expect(cpp.config!.command).toMatch(/\/bin\/g\+\+ -g -std=c\+\+17 -o/);
    expect(cpp.debug!.config.debugAdapter).toBe("codelldb");
    expect(produceContext(scratch("lib.c", "int add(int a, int b);"), ALL)).toBeNull();
  });

  it("compiled binaries of same-named files in different directories don't collide", () => {
    const a = produceContext({ ...scratch("x.rs", "fn main() {}"), path: "/a/x.rs" }, ALL)!;
    const b = produceContext({ ...scratch("x.rs", "fn main() {}"), path: "/b/x.rs" }, ALL)!;
    expect(a.debug!.config.command).not.toBe(b.debug!.config.command);
  });

  it("names come out without runtime lookups (menus)", () => {
    expect(produceContext(scratch("hi.ts"), OPTIMISTIC)!.name).toBe("hi.ts");
    expect(produceContext(scratch("hi.ts"), OPTIMISTIC)!.config!.command).toBe("npx");
    expect(produceContext(scratch("hi.js"), OPTIMISTIC)!.config!.command).toBe("node");
  });
});

describe("project producers", () => {
  const configs = [
    cfg({ id: "npm:test", kind: "npm", command: "npm", args: ["run", "test"], isTest: true }),
    cfg({ id: "pytest", kind: "pytest", command: ".venv/bin/pytest", args: [], isTest: true }),
  ];

  it("Godot scenes run with godot --path in the project holding them (Current Scene)", () => {
    const godot = [
      cfg({ id: "godot:project", kind: "godot", command: "godot", args: ["--path", "."], debugAdapter: "godot" }),
      cfg({ id: "godot:project:demo", kind: "godot", command: "godot", args: ["--path", "."], cwd: "demo" }),
    ];
    const root = produceContext({ path: `${ROOT}/levels/one.tscn`, root: ROOT, configs: godot }, OPTIMISTIC)!;
    expect(root).toMatchObject({ name: "one.tscn", scope: "file" });
    expect(root.config).toMatchObject({
      kind: "godot",
      command: "godot",
      args: ["--path", ".", "res://levels/one.tscn"],
      cwd: null,
      debugAdapter: "godot",
    });
    const nested = produceContext({ path: `${ROOT}/demo/main.tscn`, root: ROOT, configs: godot }, OPTIMISTIC)!;
    expect(nested.config).toMatchObject({ args: ["--path", ".", "res://main.tscn"], cwd: "demo" });
    // Outside a Godot project there is nothing to run.
    expect(produceContext({ path: `${ROOT}/a.tscn`, root: ROOT, configs: [] }, OPTIMISTIC)).toBeNull();
  });

  it("keeps package.json test files on the project's runner", () => {
    const p = produceContext(
      { path: `${ROOT}/src/a.test.ts`, root: ROOT, configs, content: "test('x', () => {})" },
      ALL,
    )!;
    expect(p).toMatchObject({ name: "a.test.ts", scope: "file" });
    expect(p.config!.args).toEqual(["run", "test", "--", "src/a.test.ts"]);
  });

  it("⌃⇧R picks the innermost context: test > describe > file", () => {
    const src = [
      "describe('math', () => {",
      "  it('adds', () => {",
      "    expect(1).toBe(1);",
      "  });",
      "",
      "});",
      "",
      "const x = 1;",
    ].join("\n");
    const at = (line: number) =>
      produceContext({ path: `${ROOT}/src/m.test.ts`, root: ROOT, configs, content: src, line }, ALL)!;
    expect(at(2)).toMatchObject({ name: "math > adds", scope: "element" });
    expect(at(4)).toMatchObject({ name: "math", scope: "element" });
    expect(at(7)).toMatchObject({ name: "m.test.ts", scope: "file" });
  });

  it("several equally close test configurations: one choice each, the default first", () => {
    const withUnit = [
      ...configs,
      cfg({
        id: "npm:test:unit",
        name: "npm run test:unit",
        kind: "npm",
        command: "npm",
        args: ["run", "test:unit"],
        isTest: true,
      }),
    ];
    const src = "describe('math', () => {\n  it('adds', () => {\n  });\n});\n";
    const input = { path: `${ROOT}/src/m.test.ts`, root: ROOT, configs: withUnit, content: src, line: 1 };
    const choices = produceContextChoices(input, ALL);
    expect(choices.map((c) => [c.name, c.detail, c.scope])).toEqual([
      ["math > adds", "npm:test", "element"],
      ["math > adds", "npm run test:unit", "element"],
    ]);
    expect(choices[1]!.config!.args.slice(0, 2)).toEqual(["run", "test:unit"]);
    // The file context offers the same choice; a single matching configuration needs none.
    expect(produceContextChoices({ ...input, line: undefined }, ALL).map((c) => c.detail)).toEqual([
      "npm:test",
      "npm run test:unit",
    ]);
    expect(produceContextChoices({ ...input, configs }, ALL)).toHaveLength(1);
  });

  it("python: test function > test class > file; __main__ runs the file", () => {
    const src = [
      "class TestMath:",
      "    def test_add(self):",
      "        assert 1",
      "",
      "    x = 1",
      "",
      "def helper():",
      "    pass",
    ].join("\n");
    const at = (line: number) =>
      produceContext({ path: `${ROOT}/tests/test_m.py`, root: ROOT, configs, content: src, line }, ALL)!.name;
    expect(at(2)).toBe("TestMath.test_add");
    expect(at(4)).toBe("TestMath");
    expect(at(7)).toBe("test_m.py");
    const main = 'print(1)\nif __name__ == "__main__":\n    main()\n';
    expect(produceContext(scratch("hi.py", main, 2), ALL)!).toMatchObject({ name: "hi.py", scope: "element" });
  });

  it("directories: Tests in '<dir>' and All Tests", () => {
    expect(produceDirectory({ path: `${ROOT}/tests`, root: ROOT, configs })).toMatchObject({
      name: "Tests in 'tests'",
      config: { args: ["tests"], command: ".venv/bin/pytest" },
    });
    expect(produceDirectory({ path: `${ROOT}/src/__tests__`, root: ROOT, configs })!.config!.args).toEqual([
      "run",
      "test",
      "--",
      "src/__tests__",
    ]);
    const gradle = [cfg({ id: "gradle:test", kind: "gradle", command: "./gradlew", args: ["test"], isTest: true })];
    expect(produceDirectory({ path: `${ROOT}/src/test/java`, root: ROOT, configs: gradle })).toMatchObject({
      name: "All Tests",
    });
    expect(
      produceDirectory({ path: `${ROOT}/src/test/java/com/acme`, root: ROOT, configs: gradle })!.config!.args,
    ).toEqual(["test", "--tests", "com.acme.*"]);
    expect(produceDirectory({ path: `${ROOT}/src/main`, root: ROOT, configs })).toBeNull();
    expect(produceDirectory({ path: ROOT, root: ROOT, configs })).toBeNull();
  });
});

describe("file-level gutter targets", () => {
  it("scratches: Python __main__, Go main, Rust fn main, C main; no JS", () => {
    const at = (name: string, text: string) =>
      fileTargets({ path: `${SCRATCH}/${name}`, root: ROOT, configs: [] }, text).map((t) => [t.line, t.kind]);
    expect(at("hi.py", 'x = 1\nif __name__ == "__main__":\n    print(x)')).toEqual([[1, "main"]]);
    expect(at("hi.go", "package main\n\nfunc main() {\n}")).toEqual([[2, "main"]]);
    expect(at("hihi.rs", "use std::io;\nfn main() {\n}")).toEqual([[1, "main"]]);
    expect(at("a.c", "#include <stdio.h>\nint main(void) {\n}")).toEqual([[1, "main"]]);
    expect(at("hi.js", "console.log(1)")).toEqual([]);
    expect(at("hi.ts", "console.log(123)")).toEqual([]);
  });

  it("innermost target uses declaration extents", () => {
    const src = "fn main() {\n}\n#[test]\nfn t() {\n  x();\n}\n";
    const targets = fileTargets({ path: `${SCRATCH}/a.rs`, root: ROOT, configs: [] }, src);
    expect(innermostTarget(src, targets, 4)?.name).toBe("t");
    expect(innermostTarget(src, targets, 2)).toBeNull();
    expect(innermostTarget(src, targets, 0)?.kind).toBe("main");
  });
});

describe("produceFile", () => {
  it("ignores unknown files and declaration files", () => {
    expect(produceFile(scratch("readme.md"), ALL)).toBeNull();
    expect(produceFile(scratch("types.d.ts"), ALL)).toBeNull();
  });
});

describe("Kotlin single file (.kt)", () => {
  const KT = env({ kotlinc: null, java: null });
  const hello = 'package demo\n\nfun main(args: Array<String>) {\n    println("hi")\n}';

  it("kotlinc into a runnable jar, then java -jar; no debugger", () => {
    const p = produceContext(scratch("hello.kt", hello), KT)!;
    expect(p.name).toBe("hello.kt");
    expect(p.config).toMatchObject({ kind: "kotlinc", cwd: SCRATCH, args: [], debugAdapter: null });
    expect(p.config!.command).toMatch(
      /^mkdir -p \/tmp\/openidea-run && \/bin\/kotlinc -include-runtime -d \/tmp\/openidea-run\/hello-\w+\.jar hello\.kt && \/bin\/java -jar \/tmp\/openidea-run\/hello-\w+\.jar$/,
    );
    expect(p.debug).toBeUndefined();
    // `suspend fun main()` and the gutter on it (scratch mains with a class name).
    expect(produceContext(scratch("s.kt", "suspend fun main() {}"), KT)!.config!.kind).toBe("kotlinc");
    const targets = fileTargets({ path: `${SCRATCH}/hello.kt`, root: ROOT, configs: [] }, hello);
    expect(targets.map((t) => [t.line, t.kind])).toEqual([[2, "main"]]);
    expect(produceContext(scratch("hello.kt", hello, 3), KT)!.config!.kind).toBe("kotlinc");
  });

  it("nothing to run without a top-level main; missing kotlinc / java are explained", () => {
    expect(produceContext(scratch("lib.kt", "fun helper() = 42"), KT)).toBeNull();
    const noKotlinc = produceContext(scratch("hello.kt", hello), env({ java: null }))!;
    expect(noKotlinc.config).toBeUndefined();
    expect(noKotlinc.missing!.title).toBe("Cannot run 'hello.kt'");
    expect(noKotlinc.missing!.body).toMatch(
      /The Kotlin compiler was not found \(looked for `kotlinc`\)\..*brew install kotlin/,
    );
    expect(produceContext(scratch("hello.kt", hello), env({ kotlinc: null }))!.missing!.body).toMatch(
      /Java was not found.*JDK/,
    );
  });

  it("a Gradle / Maven project runs .kt mains through the build tool", () => {
    const gradle = [cfg({ id: "gradle:run", kind: "gradle", command: "./gradlew", args: ["run"] })];
    const p = produceContext(
      { path: `${ROOT}/src/main/kotlin/App.kt`, root: ROOT, configs: gradle, content: hello },
      KT,
    )!;
    expect(p.config!.kind).not.toBe("kotlinc");
  });
});

describe("compile-and-run lines on Windows", () => {
  const WIN = (tools: Record<string, string | null>) =>
    ({
      tool: (n: string): LocatedTool | null =>
        n in tools ? { path: `C:\\Program Files\\Tools\\${n}.exe`, version: tools[n] ?? null } : null,
      compileDir: "C:\\Users\\me\\AppData\\Local\\Temp\\openidea-run",
      windows: true,
    }) satisfies ToolEnv;
  const DIR = String.raw`C:\Users\me\AppData\Local\Temp\openidea-run`;
  /** The command with the per-file hash replaced by `H`. */
  const line = (p: { config?: { command: string } } | null) =>
    p!.config!.command.replace(/-[0-9a-z]+(-test)?\.(exe|jar)/g, "-H$1.$2");

  it("cmd quoting: double quotes only where needed, never POSIX single quotes", () => {
    expect(shellWord(String.raw`C:\Program Files\x.exe`, true)).toBe(String.raw`"C:\Program Files\x.exe"`);
    expect(shellWord(String.raw`C:\tools\x.exe`, true)).toBe(String.raw`C:\tools\x.exe`);
    expect(shellWord("a&b", true)).toBe('"a&b"');
    expect(shellWord("it's", true)).toBe(`"it's"`);
    expect(shellWord("", true)).toBe('""');
    expect(shellWord("it's")).toBe(String.raw`'it'\''s'`);
  });

  it("rustc: .exe output, backslash paths, cmd mkdir", () => {
    const p = produceContext(scratch("hihi.rs", "fn main() {}"), WIN({ rustc: "1.85.0" }))!;
    expect(line(p)).toBe(
      `(if not exist ${DIR} mkdir ${DIR}) && "C:\\Program Files\\Tools\\rustc.exe" -g --edition 2021 -o ${DIR}\\hihi-H.exe hihi.rs && ${DIR}\\hihi-H.exe`,
    );
    expect(line(p.debug!)).toBe(`${DIR}\\hihi-H.exe`);
    const test = produceContext(scratch("calc.rs", "#[test]\nfn adds() {}", 1), WIN({ rustc: null }))!;
    expect(line(test)).toMatch(/--test -o \S+\\calc-H-test\.exe calc\.rs && \S+\\calc-H-test\.exe adds --exact$/);
  });

  it("clang / gcc and kotlinc", () => {
    const c = produceContext(scratch("a.c", "int main(void) {}"), WIN({ gcc: null }))!;
    expect(c.config!.command).toMatch(
      /&& "C:\\Program Files\\Tools\\gcc\.exe" -g -o \S+\\a-\w+\.exe a\.c && \S+\\a-\w+\.exe$/,
    );
    const kt = produceContext(scratch("hello.kt", "fun main() {}"), WIN({ kotlinc: null, java: null }))!;
    expect(kt.config!.command).toMatch(
      /&& "C:\\Program Files\\Tools\\kotlinc\.exe" -include-runtime -d \S+\\hello-\w+\.jar hello\.kt && "C:\\Program Files\\Tools\\java\.exe" -jar \S+\\hello-\w+\.jar$/,
    );
  });

  it("batch-file compilers (kotlinc.bat) are run with call", () => {
    const e: ToolEnv = {
      ...WIN({}),
      tool: (n) =>
        ({
          kotlinc: { path: String.raw`C:\kotlin\bin\kotlinc.bat`, version: null },
          java: { path: String.raw`C:\jdk\bin\java.exe`, version: null },
        })[n] ?? null,
    };
    expect(line(produceContext(scratch("hello.kt", "fun main() {}"), e))).toBe(
      `(if not exist ${DIR} mkdir ${DIR}) && call C:\\kotlin\\bin\\kotlinc.bat -include-runtime -d ${DIR}\\hello-H.jar hello.kt && C:\\jdk\\bin\\java.exe -jar ${DIR}\\hello-H.jar`,
    );
  });

  it("a compile directory with spaces is quoted for cmd", () => {
    const e = { ...WIN({ clang: null }), compileDir: "C:/Users/John Smith/Temp/openidea-run/" };
    const p = produceContext(scratch("a.c", "int main() {}"), e)!;
    expect(p.config!.command).toMatch(
      /^\(if not exist "C:\\Users\\John Smith\\Temp\\openidea-run" mkdir "C:\\Users\\John Smith\\Temp\\openidea-run"\) && /,
    );
    expect(p.config!.command).toMatch(
      / -o "C:\\Users\\John Smith\\Temp\\openidea-run\\a-\w+\.exe" a\.c && "C:\\Users\\John Smith\\Temp\\openidea-run\\a-\w+\.exe"$/,
    );
  });
});

describe("Go test names (GoLand)", () => {
  const GO = [
    cfg({ id: "go:run", kind: "go", command: "go", args: ["run", "."], debugAdapter: "delve" }),
    cfg({ id: "go:test", kind: "go", command: "go", args: ["test", "./..."], isTest: true, debugAdapter: "delve" }),
  ];
  const src = [
    "package calc",
    "",
    'import "testing"',
    "",
    "func TestAdd(t *testing.T) {",
    "}",
    "",
    "func TestSub(t *testing.T) {",
    '\tt.Run("zero case", func(t *testing.T) {',
    "\t})",
    "}",
    "",
    "func TestTable(t *testing.T) {",
    "\ttests := []struct{ name string }{",
    '\t\t{name: "one plus one"},',
    "\t}",
    "\tfor _, tt := range tests {",
    "\t\tt.Run(tt.name, func(t *testing.T) {})",
    "\t}",
    "}",
  ].join("\n");
  const modules = (dir: string) => (dir === ROOT ? "example.com/fixture" : undefined);
  const at = (line: number | undefined, goModule?: ContextInput["goModule"]) =>
    produceContext({ path: `${ROOT}/calc/calc_test.go`, root: ROOT, configs: GO, content: src, line, goModule }, ALL)!;

  it("a test function: 'TestFoo in <import path>' with -run '^TestFoo$'", () => {
    const p = at(5, modules);
    expect(p.name).toBe("TestAdd in example.com/fixture/calc");
    expect(p.config).toMatchObject({
      args: ["test", "./calc", "-run", "^TestAdd$"],
      debugAdapter: "delve",
      isTest: true,
    });
  });

  it("subtests and table-driven entries", () => {
    expect(at(8, modules)).toMatchObject({ name: "TestSub/zero_case in example.com/fixture/calc" });
    expect(at(8, modules).config!.args).toEqual(["test", "./calc", "-run", "^TestSub$/^zero_case$"]);
    expect(at(14, modules).config!.args).toEqual(["test", "./calc", "-run", "^TestTable$/^one_plus_one$"]);
    // Inside the t.Run body of a table test: the whole test.
    expect(at(17, modules).config!.args).toEqual(["test", "./calc", "-run", "^TestTable$"]);
  });

  it("the file and the directory: 'go test <import path>'", () => {
    expect(at(undefined, modules).name).toBe("go test example.com/fixture/calc");
    expect(at(undefined, modules).config!.args).toEqual(["test", "./calc"]);
    const dir = produceDirectory({ path: `${ROOT}/internal/tests`, root: ROOT, configs: GO, goModule: modules })!;
    expect(dir.name).toBe("go test example.com/fixture/internal/tests/...");
    expect(dir.config!.args).toEqual(["test", "./internal/tests/..."]);
    expect(dir.config!.name).toBe(dir.name);
  });

  it("without go.mod read yet: the package clause", () => {
    expect(at(5).name).toBe("TestAdd in calc");
    expect(at(undefined).name).toBe("go test calc");
  });

  it("nested modules use their own go.mod", () => {
    const nested = [
      cfg({ id: "go:test:api", kind: "go", command: "go", args: ["test", "./..."], cwd: "api", isTest: true }),
    ];
    const p = produceContext(
      {
        path: `${ROOT}/api/calc_test.go`,
        root: ROOT,
        configs: nested,
        content: src,
        line: 5,
        goModule: (d) => (d === `${ROOT}/api` ? "example.com/api" : undefined),
      },
      ALL,
    )!;
    expect(p.name).toBe("TestAdd in example.com/api");
    expect(p.config!.args).toEqual(["test", ".", "-run", "^TestAdd$"]);
  });
});
