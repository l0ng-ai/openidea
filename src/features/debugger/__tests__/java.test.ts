import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const invoked: Array<[string, unknown[]]> = [];
let shortenCommandLine: string | null = null;
let kotlinFiles = false;
const files: Record<string, string> = {};
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
  return {
    ...real,
    commands: {
      ...real.commands,
      findFiles: (name: string) =>
        ok(
          name === "Main.java"
            ? [{ path: "/p/api/src/main/java/a/Main.java", relPath: "api/src/main/java/a/Main.java" }]
            : [],
        ),
      fsReadText: (path: string) => ok(files[path] ?? "package a;\npublic class Main {}"),
      runConfigs: () => ok([]),
      fsReadDir: (path: string) =>
        ok(
          kotlinFiles && path.endsWith("/src")
            ? [{ name: "Main.kt", path: `${path}/Main.kt`, kind: "file", excluded: false }]
            : [],
        ),
      javaResolveLaunch: (...a: unknown[]) => {
        invoked.push(["javaResolveLaunch", a]);
        return ok({
          build: "succeeded",
          projectRoot: "/p",
          classPaths: ["/p/target/classes", "/m2/a.jar"],
          modulePaths: [],
          pathListSeparator: ":",
          javaHome: "/jdk21",
          javaExec: "/jdk21/bin/java",
          shortenCommandLine,
          errors: [],
          errorCount: 0,
          hints: [],
        });
      },
      javaDebugServer: (...a: unknown[]) => {
        invoked.push(["javaDebugServer", a]);
        return ok(41234);
      },
    },
  };
});

const { isJavaDebuggable, javaAttachConfig, javaLaunchConfig, javaProjectName } = await import("../java");

const app: RunConfig = {
  id: "application:a.Main",
  name: "Main",
  kind: "application",
  command: "java",
  args: ["-Xmx1g", "-cp", "${classpath}", "a.Main", "--port", "8081 x"],
  cwd: "api",
  module: "api",
  env: { A: "1" },
  detected: true,
  isTest: false,
  debugAdapter: "java-debug",
};

describe("Java debugging (java-debug through jdtls)", () => {
  beforeEach(() => {
    invoked.length = 0;
    shortenCommandLine = null;
    kotlinFiles = false;
  });

  it("launches Application configs with the resolved classpath on jdtls' debug server", async () => {
    expect(isJavaDebuggable(app)).toBe(true);
    expect(isJavaDebuggable({ ...app, kind: "maven" })).toBe(false);
    const l = await javaLaunchConfig(app, "/p");
    expect(invoked).toEqual([
      ["javaResolveLaunch", ["api", false, "automatic", expect.any(Number)]],
      ["javaDebugServer", ["api"]],
    ]);
    expect(l).toMatchObject({ adapter: "java-debug", request: "launch", cwd: "/p/api", args: [], env: { A: "1" } });
    expect(JSON.parse(l.extraJson!)).toMatchObject({
      debugServer: 41234,
      mainClass: "a.Main",
      classPaths: ["/p/target/classes", "/m2/a.jar"],
      javaExec: "/jdk21/bin/java",
      vmArgs: "-Xmx1g",
      args: '--port "8081 x"',
      console: "internalConsole",
      shortenCommandLine: "none",
      projectName: "p",
    });
  });

  it("echoes the equivalent Java command in the Debug console", async () => {
    const report = vi.fn();
    await javaLaunchConfig(app, "/p", {
      request: 1,
      signal: new AbortController().signal,
      report,
    });
    expect(report).toHaveBeenCalledWith(
      '/jdk21/bin/java -Xmx1g -cp /p/target/classes:/m2/a.jar a.Main --port "8081 x"\n',
    );
  });

  it("debugs Spring Boot with coloured console output, as Run does", async () => {
    const boot = { ...app, kind: "spring-boot" };
    expect(JSON.parse((await javaLaunchConfig(boot, "/p")).extraJson!).vmArgs).toBe(
      "-Dspring.output.ansi.enabled=always -Xmx1g",
    );
    const own = { ...boot, args: ["-Dspring.output.ansi.enabled=never", ...app.args] };
    expect(JSON.parse((await javaLaunchConfig(own, "/p")).extraJson!).vmArgs).toBe(
      "-Dspring.output.ansi.enabled=never -Xmx1g",
    );
  });

  it("passes the configuration's VM options to java-debug's vmArgs, before the main class", async () => {
    const args = [
      "-Ddemo.flag=on",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-Dname=a b",
      "-cp",
      "${classpath}",
    ];
    const l = await javaLaunchConfig({ ...app, args: [...args, "a.App", "--spring.profiles.active=dev"] }, "/p");
    expect(JSON.parse(l.extraJson!)).toMatchObject({
      mainClass: "a.App",
      vmArgs: '-Ddemo.flag=on --add-opens java.base/java.lang=ALL-UNNAMED "-Dname=a b"',
      args: "--spring.profiles.active=dev",
    });
  });

  it("lets java-debug shorten a classpath too long for the OS, as Run does", async () => {
    for (const how of ["jarmanifest", "argfile"]) {
      shortenCommandLine = how;
      const l = await javaLaunchConfig(app, "/p");
      expect(JSON.parse(l.extraJson!).shortenCommandLine).toBe(how);
    }
  });

  it("routes a Kotlin main to the Kotlin adapter and preserves JVM launch arguments", async () => {
    const config = { ...app, debugAdapter: "kotlin-debug-adapter" };
    expect(isJavaDebuggable(config)).toBe(true);
    const l = await javaLaunchConfig(config, "/p");
    expect(l).toMatchObject({ adapter: "kotlin-debug-adapter", request: "launch", cwd: "/p/api", env: { A: "1" } });
    expect(JSON.parse(l.extraJson!)).toMatchObject({
      projectRoot: "/p/api",
      mainClass: "a.Main",
      classPaths: ["/p/target/classes", "/m2/a.jar"],
      javaExec: "/jdk21/bin/java",
      vmArguments: ["-Xmx1g"],
      programArgs: ["--port", "8081 x"],
    });
    expect(invoked.some(([command]) => command === "javaDebugServer")).toBe(false);
  });

  it("routes launch and JDWP attach in a mixed module to Kotlin without starting jdtls' adapter", async () => {
    kotlinFiles = true;
    expect((await javaLaunchConfig(app, "/p")).adapter).toBe("kotlin-debug-adapter");
    const l = await javaAttachConfig({ name: "mvn test", module: "api", hostName: "remote", port: 5005 }, "/p");
    expect(l.adapter).toBe("kotlin-debug-adapter");
    expect(JSON.parse(l.extraJson!)).toEqual({
      projectRoot: "/p/api",
      hostName: "remote",
      port: 5005,
      timeout: 30_000,
    });
    expect(invoked.some(([command]) => command === "javaDebugServer")).toBe(false);
  });

  it("attaches to a JDWP agent", async () => {
    const l = await javaAttachConfig({ name: "mvn test", module: "", hostName: "127.0.0.1", port: 5005 }, "/p");
    expect(l).toMatchObject({ request: "attach", cwd: "/p" });
    expect(JSON.parse(l.extraJson!)).toMatchObject({
      debugServer: 41234,
      hostName: "127.0.0.1",
      port: 5005,
      projectName: "p",
    });
  });
});

it.each(["sibling", "/outside/modules"])("debugs from %s with the main class module", async (cwd) => {
  kotlinFiles = false;
  for (const module of ["api", undefined]) {
    invoked.length = 0;
    const launch = await javaLaunchConfig({ ...app, module, cwd }, "/p");
    expect(invoked).toContainEqual(["javaResolveLaunch", ["api", false, "automatic", expect.any(Number)]]);
    expect(invoked).toContainEqual(["javaDebugServer", ["api"]]);
    expect(launch.cwd).toBe(cwd.startsWith("/") ? cwd : `/p/${cwd}`);
  }
});

describe("naming the Java project jdtls imported", () => {
  beforeEach(() => {
    invoked.length = 0;
    for (const key of Object.keys(files)) delete files[key];
  });

  it("uses the Maven artifactId, not the folder name, and skips the parent's", async () => {
    files["/p/pom.xml"] =
      "<project><parent><artifactId>orders-parent</artifactId></parent><artifactId>openidea-fixture-orders</artifactId></project>";
    expect(await javaProjectName("/p")).toBe("openidea-fixture-orders");
  });

  it("prefers the Eclipse project descriptor", async () => {
    files["/p/.project"] = "<projectDescription><name>taihe</name></projectDescription>";
    files["/p/pom.xml"] = "<project><artifactId>orders</artifactId></project>";
    expect(await javaProjectName("/p")).toBe("taihe");
  });

  it("falls back to the folder name when the project says nothing, including unresolved properties", async () => {
    expect(await javaProjectName("/p/api")).toBe("api");
    files["/p/pom.xml"] = "<project><artifactId>${revision}</artifactId></project>";
    expect(await javaProjectName("/p")).toBe("p");
  });
});

it("reports a save failure before starting Java Debug", async () => {
  invoked.length = 0;
  const saveAll = vi.fn().mockRejectedValue(new Error("save failed"));
  await expect(
    javaLaunchConfig(app, "/p", {
      request: 1,
      signal: new AbortController().signal,
      saveAll,
    }),
  ).rejects.toThrow("save failed");
  expect(invoked).toEqual([]);
});
