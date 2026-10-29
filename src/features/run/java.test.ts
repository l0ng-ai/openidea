import { beforeEach, describe, expect, it } from "vitest";
import type { JavaLaunchInfo, RunConfig } from "@/platform/ipc";
import {
  formatCompileErrors,
  joinJavaArgs,
  jdwpListeningPort,
  parseJavaArgs,
  resolveJavaCommand,
} from "@/platform/javaLaunch";
import { useProject } from "@/platform/project";
import { applicationConfig, jvmModuleDir, jvmTestConfig } from "./application";
import { buildRows } from "./ConfigChooser";
import { jdwpLaunch } from "./javaDebug";
import { scanJvmTargets } from "./jvmTargets";
import { adoptTemporary, MAX_TEMPORARY, saveTemporary, testReportEvents, useRun } from "./store";
import { detectRunTargets, targetConfig } from "./targets";

const cfg = (over: Partial<RunConfig> & { id: string; kind: string }): RunConfig => ({
  name: over.id,
  command: over.kind === "maven" ? "./mvnw" : over.kind,
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...over,
});

const pick = (src: string, rel: string, kotlin = false) =>
  scanJvmTargets(src, rel, kotlin).map((t) => [t.line, t.kind, t.className, t.method ?? null, t.spring ?? false]);

describe("scanJvmTargets (Java)", () => {
  it("finds a Spring Boot main with annotations on earlier lines", () => {
    const src = [
      "package com.example.demo;", // 0
      "",
      "import org.springframework.boot.SpringApplication;",
      "",
      "@SpringBootApplication(", // 4
      '    scanBasePackages = "com.example" // not a ) here',
      ")",
      "public class SpringDemoApplication {", // 7
      "  /* public static void main(String[] args) in a comment */",
      '  static String s = "void main(String[] a) {";',
      "  public static void", // 10
      "  main(",
      "      final String... args) {",
      "    SpringApplication.run(SpringDemoApplication.class, args);",
      "  }",
      "}",
    ].join("\n");
    expect(pick(src, "src/main/java/com/example/demo/SpringDemoApplication.java")).toEqual([
      [11, "main", "com.example.demo.SpringDemoApplication", null, true],
    ]);
  });

  it("ignores non-main methods named main and Java 25 instance mains count", () => {
    expect(pick("class A {\n  int main(String[] a) { return 0; }\n  static void main(int x) {}\n}", "A.java")).toEqual(
      [],
    );
    expect(pick("class B {\n  void main() {}\n}", "B.java")).toEqual([[1, "main", "B", null, false]]);
  });

  it("finds JUnit tests, nested @Nested classes and multi-line annotations", () => {
    const src = [
      "package a.b;", // 0
      "class OrderTest {", // 1
      "  @Test",
      "  void plain() {}", // 3
      "  @ParameterizedTest(",
      '      name = "{0}")',
      "  @ValueSource(ints = {1, 2})",
      "  void param(int x) {", // 7
      "    Runnable r = new Runnable() { public void run() {} };",
      "  }",
      "  void helper() {}",
      "  @Nested",
      "  class WhenEmpty {", // 12
      "    @org.junit.jupiter.api.Test void fails() {}", // 13
      "  }",
      "  static class Fixture {",
      "    @Test void inner() {}", // 16
      "  }",
      "}",
    ].join("\n");
    expect(pick(src, "src/test/java/a/b/OrderTest.java")).toEqual([
      [1, "suite", "a.b.OrderTest", null, false],
      [3, "test", "a.b.OrderTest", "plain", false],
      [7, "test", "a.b.OrderTest", "param", false],
      [12, "suite", "a.b.OrderTest$WhenEmpty", null, false],
      [13, "test", "a.b.OrderTest$WhenEmpty", "fails", false],
      [15, "suite", "a.b.OrderTest$Fixture", null, false],
      [16, "test", "a.b.OrderTest$Fixture", "inner", false],
    ]);
  });
});

describe("scanJvmTargets (Kotlin)", () => {
  it("top-level main runs the file facade, objects and companions with @JvmStatic", () => {
    expect(pick("package app\n\nfun main(args: Array<String>) {}", "src/main/kotlin/app/server.kt", true)).toEqual([
      [2, "main", "app.ServerKt", null, false],
    ]);
    expect(pick('@file:JvmName("Boot")\npackage app\nfun main() {}', "src/main/kotlin/app/x.kt", true)).toEqual([
      [2, "main", "app.Boot", null, false],
    ]);
    const companion = [
      "package app",
      "@SpringBootApplication",
      "class Demo",
      "class Tool {",
      "  companion object {",
      "    @JvmStatic",
      "    fun main(args: Array<String>) {}", // 6
      "  }",
      "}",
      "object Cli { @JvmStatic fun main(args: Array<String>) {} }", // 9
    ].join("\n");
    expect(pick(companion, "src/main/kotlin/app/Tool.kt", true)).toEqual([
      [6, "main", "app.Tool", null, false],
      [9, "main", "app.Cli", null, false],
    ]);
  });

  it("finds backticked test names", () => {
    const kt = "class CalcTest {\n  @Test\n  fun `adds numbers`() {}\n}";
    expect(pick(kt, "src/test/kotlin/CalcTest.kt", true)).toEqual([
      [0, "suite", "CalcTest", null, false],
      [2, "test", "CalcTest", "adds numbers", false],
    ]);
  });
});

describe("application configurations", () => {
  const maven = [cfg({ id: "maven:test", kind: "maven", args: ["test"], isTest: true })];

  it("derives the module directory", () => {
    expect(jvmModuleDir("src/main/java/a/App.java")).toBe("");
    expect(jvmModuleDir("services/api/src/test/kotlin/a/T.kt")).toBe("services/api");
    expect(jvmModuleDir("odd/App.java", [cfg({ id: "m", kind: "maven", cwd: "odd" })])).toBe("odd");
  });

  it("creates an Application / Spring Boot config named after the class", () => {
    const rel = "src/main/java/com/example/demo/SpringDemoApplication.java";
    const src =
      "package com.example.demo;\n@SpringBootApplication\nclass SpringDemoApplication {\n public static void main(String[] a) {}\n}";
    const main = detectRunTargets(src, rel).find((t) => t.kind === "main")!;
    const c = targetConfig(main, rel, maven, src)!;
    expect(c).toMatchObject({
      id: "application:com.example.demo.SpringDemoApplication",
      name: "SpringDemoApplication",
      kind: "spring-boot",
      command: "java",
      args: ["-cp", "${classpath}", "com.example.demo.SpringDemoApplication"],
      cwd: null,
      debugAdapter: "java-debug",
      isTest: false,
    });
    expect(applicationConfig({ className: "a.Tool" }, "m/src/test/java/a/Tool.java")).toMatchObject({
      kind: "application",
      cwd: "m",
      args: ["-cp", "${testClasspath}", "a.Tool"],
    });
  });

  it("scopes Maven and Gradle test configs to a class or method", () => {
    const file = cfg({ id: "f", kind: "maven", args: ["test", "-Dtest=OrderTest"], isTest: true });
    expect(jvmTestConfig(file, "a.OrderTest$Nested", "fails")).toMatchObject({
      name: "Nested.fails",
      args: ["test", "-Dtest=a.OrderTest$Nested#fails", "-Dsurefire.failIfNoSpecifiedTests=false"],
    });
    const gradle = cfg({ id: "g", kind: "gradle", args: ["test", "--tests", "*OrderTest"], isTest: true });
    expect(jvmTestConfig(gradle, "a.OrderTest", undefined)!.args).toEqual(["test", "--tests", "a.OrderTest"]);
  });
});

describe("java compile errors", () => {
  const base: Omit<JavaLaunchInfo, "errors" | "errorCount" | "hints"> = {
    build: "withErrors",
    projectRoot: "/p",
    classPaths: [],
    modulePaths: [],
    javaHome: null,
    javaExec: null,
    shortenCommandLine: null,
  };

  it("lists the first errors, counts the rest and adds hints", () => {
    const report = formatCompileErrors({
      ...base,
      errors: [{ path: "/p/src/A.java", line: 72, column: 5, message: "The method getUsername() is undefined" }],
      errorCount: 3,
      hints: ["Install Lombok"],
    });
    expect(report).toBe(
      "/p/src/A.java:72:5: error: The method getUsername() is undefined\n" +
        "… and 2 more errors (see the Problems tool window)\nInstall Lombok\n",
    );
    expect(formatCompileErrors({ ...base, errors: [], errorCount: 0, hints: [] })).toBe("");
  });
});

describe("java command lines", () => {
  const info: JavaLaunchInfo = {
    build: "succeeded",
    projectRoot: "/p",
    classPaths: ["/p/target/classes", "/m2/a.jar"],
    modulePaths: [],
    javaHome: "/jdk21",
    javaExec: "/jdk21/bin/java",
    shortenCommandLine: "none",
    errors: [],
    errorCount: 0,
    hints: [],
  };

  it("parses VM options, main class and program arguments", () => {
    expect(parseJavaArgs(["-Xmx1g", "--add-opens", "a/b=ALL", "-cp", "${classpath}", "a.Main", "-v", "x"])).toEqual({
      vmArgs: ["-Xmx1g", "--add-opens", "a/b=ALL"],
      mainClass: "a.Main",
      programArgs: ["-v", "x"],
      classpath: "runtime",
      explicitClasspath: null,
    });
    expect(parseJavaArgs(["-cp", "lib/*", "a.Main"]).explicitClasspath).toBe("lib/*");
    expect(parseJavaArgs(["-Dx=1"]).mainClass).toBeNull();
  });

  it("substitutes the classpath and the project JDK", () => {
    const c = applicationConfig({ className: "a.Main" }, "src/main/java/a/Main.java");
    const r = resolveJavaCommand({ ...c, args: ["-Dx=1", ...c.args, "arg"] }, info);
    expect(r.command).toBe("/jdk21/bin/java");
    expect(r.args).toEqual(["-Dx=1", "-cp", "/p/target/classes:/m2/a.jar", "a.Main", "arg"]);
    expect(resolveJavaCommand(c, { ...info, modulePaths: ["/m/x.jar"] }, ";").args.slice(0, 2)).toEqual([
      "--module-path",
      "/m/x.jar",
    ]);
  });

  it("joins arguments for java-debug and reads JDWP's port", () => {
    expect(joinJavaArgs(["a", "b c", 'q"'])).toBe('a "b c" "q\\""');
    expect(jdwpListeningPort("Listening for transport dt_socket at address: 50123")).toBe(50123);
    expect(jdwpListeningPort("Listening for transport dt_socket at address: 127.0.0.1:5005")).toBe(5005);
    expect(jdwpListeningPort("[INFO] Listening")).toBeNull();
  });
});

describe("debugging build tool configurations", () => {
  it("adds a waiting JDWP agent to spring-boot:run, Surefire and Gradle", () => {
    const boot = jdwpLaunch(cfg({ id: "b", kind: "maven", args: ["spring-boot:run"] }))!;
    expect(boot.args[1]).toMatch(
      /^-Dspring-boot\.run\.jvmArguments=-agentlib:jdwp=.*suspend=y.*address=127\.0\.0\.1:0$/,
    );
    const merged = jdwpLaunch(
      cfg({ id: "b", kind: "maven", args: ["spring-boot:run", "-Dspring-boot.run.jvmArguments=-Xmx1g"] }),
    )!;
    expect(merged.args[1]).toMatch(/^-Dspring-boot\.run\.jvmArguments=-Xmx1g -agentlib:jdwp=/);
    const test = jdwpLaunch(cfg({ id: "t", kind: "maven", args: ["test", "-Dtest=A#b"], isTest: true }))!;
    expect(test.args.some((a) => a.startsWith("-Dmaven.surefire.debug=-agentlib:jdwp="))).toBe(true);
    expect(jdwpLaunch(cfg({ id: "g", kind: "gradle", args: ["bootRun"] }))!.args).toEqual(["bootRun", "--debug-jvm"]);
    expect(jdwpLaunch(cfg({ id: "p", kind: "maven", args: ["package"] }))).toBeNull();
    expect(jdwpLaunch(cfg({ id: "n", kind: "npm", args: ["test"] }))).toBeNull();
  });

  const AGENT = /-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127\.0\.0\.1:0$/;

  it.each([
    ["tomcat7:run"],
    ["org.apache.tomcat.maven:tomcat7-maven-plugin:2.2:run"],
    ["jetty:run"],
    ["jetty:run-war"],
    ["exec:java"],
  ])("debugs Maven's own JVM for the in-process goal %s", (goal) => {
    const out = jdwpLaunch(cfg({ id: "m", kind: "maven", args: ["clean", goal], env: { MAVEN_OPTS: "-Xmx1g" } }))!;
    expect(out.args).toEqual(["clean", goal]);
    expect(out.env.MAVEN_OPTS).toMatch(/^-Xmx1g -agentlib:jdwp=/);
    expect(out.env.MAVEN_OPTS).toMatch(AGENT);
  });

  it("keeps plain Maven builds out of the debugger unless set to the Java debugger", () => {
    expect(jdwpLaunch(cfg({ id: "p", kind: "maven", args: ["exec:exec"] }))).toBeNull();
    const chosen = jdwpLaunch(cfg({ id: "p", kind: "maven", args: ["package"], debugAdapter: "java-debug" }))!;
    expect(chosen.env.MAVEN_OPTS).toMatch(AGENT);
  });

  it.each([
    ["shell", "C:\\apache-tomcat-9.0.98\\bin\\catalina.bat", ["run"]],
    ["shell", "/opt/tomcat9/bin/catalina.sh", ["run"]],
    ["program", "java", ["-jar", "app.war"]],
  ])("starts a %s configuration set to the Java debugger with an agent in JAVA_TOOL_OPTIONS", (kind, command, args) => {
    const rc = cfg({ id: "tomcat9", kind, command, args, debugAdapter: "java-debug" });
    const out = jdwpLaunch(rc)!;
    expect(out.command).toBe(command);
    expect(out.args).toEqual(args);
    expect(out.env.JAVA_TOOL_OPTIONS).toMatch(AGENT);
    const merged = jdwpLaunch({ ...rc, env: { JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" } })!;
    expect(merged.env.JAVA_TOOL_OPTIONS).toMatch(/^-Dfile\.encoding=UTF-8 -agentlib:jdwp=/);
  });

  it("leaves Application configurations and other debuggers alone", () => {
    for (const kind of ["application", "spring-boot"])
      expect(jdwpLaunch(cfg({ id: "a", kind, command: "java", debugAdapter: "java-debug" }))).toBeNull();
    expect(jdwpLaunch(cfg({ id: "s", kind: "shell", command: "./run.sh", debugAdapter: "debugpy" }))).toBeNull();
    expect(jdwpLaunch(cfg({ id: "g", kind: "gradle", args: ["build"], debugAdapter: "java-debug" }))).toBeNull();
  });
});

describe("JUnit XML reports", () => {
  it("become tree results with failure output and source location", () => {
    const events = testReportEvents([
      { className: "a.B", name: "ok", status: "passed", durationMs: 3, message: null, output: null },
      {
        className: "a.B$Inner",
        name: "bad",
        status: "failed",
        durationMs: null,
        message: "expected 1",
        output: "AssertionError\n\tat org.junit.Assert.fail(Assert.java:1)\n\tat a.B$Inner.bad(B.java:42)",
      },
    ]);
    expect(events[0]).toEqual({ type: "result", path: ["a.B", "ok"], status: "passed", durationMs: 3 });
    expect(events).toContainEqual({ type: "output", path: ["a.B$Inner", "bad"], line: "expected 1" });
    expect(events).toContainEqual({
      type: "location",
      path: ["a.B$Inner", "bad"],
      location: { path: "a/B.java", line: 42, resolve: "name", className: "a.B$Inner" },
    });
  });
});

describe("temporary configurations", () => {
  beforeEach(() => {
    localStorage.clear();
    useProject.setState({ project: { root: "/p" } } as never);
    useRun.setState({
      configs: [cfg({ id: "maven:spring-boot:run", kind: "maven" })],
      temporary: [],
      selectedId: null,
      sessions: [],
    });
  });

  it("are added, selected, capped and persisted", () => {
    const apps = Array.from({ length: MAX_TEMPORARY + 2 }, (_, i) =>
      applicationConfig({ className: `a.App${i}` }, "src/main/java/a/App.java"),
    );
    for (const a of apps) adoptTemporary(a);
    const s = useRun.getState();
    expect(s.temporary).toHaveLength(MAX_TEMPORARY);
    expect(s.temporary).not.toContain(apps[0]!.id);
    expect(s.selectedId).toBe(apps[apps.length - 1]!.id);
    expect(s.configs.filter((c) => c.kind === "application")).toHaveLength(MAX_TEMPORARY);
    expect(JSON.parse(localStorage.getItem("openidea.run.temporary:/p")!)).toHaveLength(MAX_TEMPORARY);
    // Reusing an existing temporary moves it last instead of duplicating it.
    adoptTemporary(apps[3]!);
    expect(useRun.getState().temporary.at(-1)).toBe(apps[3]!.id);
    expect(useRun.getState().configs.filter((c) => c.id === apps[3]!.id)).toHaveLength(1);
  });

  it("reuse a saved configuration with the same id", () => {
    const saved = cfg({ id: "application:a.Main", kind: "application", name: "Mine", detected: false });
    useRun.setState({ configs: [saved] });
    const used = adoptTemporary(applicationConfig({ className: "a.Main" }, "src/main/java/a/Main.java"));
    expect(used.name).toBe("Mine");
    expect(useRun.getState().temporary).toEqual([]);
  });

  it("offer Save in the chooser while selected", async () => {
    const app = adoptTemporary(applicationConfig({ className: "a.Main" }, "src/main/java/a/Main.java"));
    const { configs, temporary } = useRun.getState();
    const rows = buildRows(configs, "", app, temporary);
    expect(rows[0]).toMatchObject({ type: "save", config: { id: app.id } });
    expect(buildRows(configs, "x", app, temporary)[0]?.type).not.toBe("save");
    // Not a desktop app in tests: saving fails at the IPC layer but the config stops being temporary.
    await saveTemporary(app.id).catch(() => undefined);
    expect(useRun.getState().temporary).toEqual([]);
  });
});
