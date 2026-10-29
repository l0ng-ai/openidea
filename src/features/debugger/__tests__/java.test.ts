import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";

const invoked: Array<[string, unknown[]]> = [];
let shortenCommandLine: string | null = null;
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
  return {
    ...real,
    commands: {
      ...real.commands,
      javaResolveLaunch: (...a: unknown[]) => {
        invoked.push(["javaResolveLaunch", a]);
        return ok({
          build: "succeeded",
          projectRoot: "/p",
          classPaths: ["/p/target/classes", "/m2/a.jar"],
          modulePaths: [],
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

const { isJavaDebuggable, javaAttachConfig, javaLaunchConfig } = await import("../java");

const app: RunConfig = {
  id: "application:a.Main",
  name: "Main",
  kind: "spring-boot",
  command: "java",
  args: ["-Xmx1g", "-cp", "${classpath}", "a.Main", "--port", "8081 x"],
  cwd: "api",
  env: { A: "1" },
  detected: true,
  isTest: false,
  debugAdapter: "java-debug",
};

describe("Java debugging (java-debug through jdtls)", () => {
  beforeEach(() => {
    invoked.length = 0;
    shortenCommandLine = null;
  });

  it("launches Application configs with the resolved classpath on jdtls' debug server", async () => {
    expect(isJavaDebuggable(app)).toBe(true);
    expect(isJavaDebuggable({ ...app, kind: "maven" })).toBe(false);
    const l = await javaLaunchConfig(app, "/p");
    expect(invoked).toEqual([
      ["javaResolveLaunch", ["api", false, true]],
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
    });
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

  it("attaches to a JDWP agent", async () => {
    const l = await javaAttachConfig({ name: "mvn test", module: "", hostName: "127.0.0.1", port: 5005 }, "/p");
    expect(l).toMatchObject({ request: "attach", cwd: "/p" });
    expect(JSON.parse(l.extraJson!)).toMatchObject({ debugServer: 41234, hostName: "127.0.0.1", port: 5005 });
  });
});
