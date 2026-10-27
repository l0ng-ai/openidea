import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { registerRunConfigType } from "@/workbench/contributions";

const invoked: Array<[string, unknown[]]> = [];
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
  return {
    ...real,
    commands: {
      ...real.commands,
      javaDebugServer: (...a: unknown[]) => {
        invoked.push(["javaDebugServer", a]);
        return ok(41234);
      },
    },
  };
});

const { javaAttachConfig } = await import("../java");
const remote = await import("../remote");
const { missingParams, newConfigOfType, isDebugOnly, terminalApplies, withParams } =
  await import("@/features/run/types");
const { validateConfig } = await import("@/features/run/configs");

const {
  REMOTE_TYPES,
  remoteJvmType,
  goRemoteType,
  pythonRemoteType,
  nodeRemoteType,
  jdwpAgentArgs,
  remoteAttachConfig,
  remoteJvmTarget,
} = remote;

function configOf(type: (typeof REMOTE_TYPES)[number], params: Record<string, string> = {}): RunConfig {
  const c = newConfigOfType(type, []);
  return withParams({ ...c, name: "Remote" }, { ...c.params, ...params }, type);
}

let disposers: Array<() => void> = [];
beforeEach(() => {
  invoked.length = 0;
  disposers = REMOTE_TYPES.map(registerRunConfigType);
});
afterEach(() => disposers.forEach((d) => d()));

describe("remote debug configuration types", () => {
  it.each(REMOTE_TYPES.map((t) => [t.id, t] as const))(
    "%s is debug-only, launches nothing and is valid by default",
    (_, type) => {
      const c = configOf(type);
      expect(type.debugOnly).toBe(true);
      expect(isDebugOnly(c)).toBe(true);
      expect(c.debugAdapter).toBe(type.debugAdapter);
      expect(c.command).toBe("");
      expect(terminalApplies(c, type)).toBe(false);
      expect(validateConfig(c, [c])).toEqual({});
      expect(missingParams(c, type)).toEqual({});
    },
  );

  it.each(REMOTE_TYPES.map((t) => [t.id, t] as const))("%s rejects a bad port and an empty host", (_, type) => {
    expect(missingParams(configOf(type, { port: "70000" }), type)).toEqual({
      port: "Port must be a number from 1 to 65535",
    });
    expect(missingParams(configOf(type, { port: "abc" }), type).port).toBeDefined();
    expect(missingParams(configOf(type, { host: "" }), type)).toEqual({ host: "Host is required" });
  });

  it("Remote JVM Debug defaults to attaching to localhost:5005", () => {
    expect(configOf(remoteJvmType).params).toEqual({ mode: "attach", host: "localhost", port: "5005", jdk: "9" });
  });
});

describe("Remote JVM Debug: command line arguments for remote JVM", () => {
  it.each([
    [{ jdk: "9" }, "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"],
    [{ jdk: "5" }, "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005"],
    [{ jdk: "1.4" }, "-Xdebug -Xrunjdwp:transport=dt_socket,server=y,suspend=n,address=5005"],
    [{ jdk: "9", port: "8000" }, "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:8000"],
    [
      { mode: "listen", host: "dev-box", port: "5005" },
      "-agentlib:jdwp=transport=dt_socket,server=n,address=dev-box:5005,suspend=y",
    ],
  ])("%j → %s", (params, expected) => {
    expect(jdwpAgentArgs({ ...remoteJvmType.defaults, ...params })).toBe(expected);
  });

  it("is shown as a read-only field that follows the form", () => {
    const field = remoteJvmType.fields.find((f) => f.key === "args")!;
    expect(field.control).toBe("output");
    expect(field.value!({ port: "6006", jdk: "5" })).toContain("address=6006");
  });
});

describe("remote attach requests", () => {
  it("Remote JVM Debug attaches java-debug to host:port with the module's sources", async () => {
    const c = configOf(remoteJvmType, { host: "10.0.0.5", port: "5006", module: "api" });
    const t = remoteJvmTarget(c);
    expect(t).toEqual({ mode: "attach", host: "10.0.0.5", port: 5006, module: "api" });
    const l = await javaAttachConfig({ name: c.name, module: t.module, hostName: t.host, port: t.port }, "/p");
    expect(invoked).toEqual([["javaDebugServer", ["api"]]]);
    expect(l.adapter).toBe("java-debug");
    expect(l.request).toBe("attach");
    expect(l.cwd).toBe("/p/api");
    expect(JSON.parse(l.extraJson!)).toMatchObject({ debugServer: 41234, hostName: "10.0.0.5", port: 5006 });
  });

  it("Remote JVM Debug in listen mode", () => {
    expect(remoteJvmTarget(configOf(remoteJvmType, { mode: "listen" })).mode).toBe("listen");
  });

  it("Go Remote connects to dlv --headless and maps the source root", () => {
    const l = remoteAttachConfig(configOf(goRemoteType, { host: "build", remoteRoot: "/go/src/app" }), "/p")!;
    expect(l).toMatchObject({ adapter: "delve", request: "attach", cwd: "/p" });
    expect(JSON.parse(l.extraJson!)).toEqual({
      debugServer: "build:2345",
      mode: "remote",
      substitutePath: [{ from: "/p", to: "/go/src/app" }],
    });
    const plain = JSON.parse(remoteAttachConfig(configOf(goRemoteType), "/p")!.extraJson!);
    expect(plain).toEqual({ debugServer: "localhost:2345", mode: "remote" });
  });

  it("Python remote connects to debugpy --listen with pathMappings", () => {
    const l = remoteAttachConfig(
      configOf(pythonRemoteType, { host: "::1", localRoot: "svc", remoteRoot: "/app" }),
      "/p",
    )!;
    expect(l.adapter).toBe("debugpy");
    expect(JSON.parse(l.extraJson!)).toMatchObject({
      debugServer: "[::1]:5678",
      pathMappings: [{ localRoot: "/p/svc", remoteRoot: "/app" }],
    });
  });

  it("Attach to Godot connects to the editor's debug adapter for the project", () => {
    const l = remoteAttachConfig(configOf(remote.godotAttachType), "/p/game")!;
    expect(l).toMatchObject({ adapter: "godot", request: "attach", cwd: "/p/game" });
    expect(JSON.parse(l.extraJson!)).toEqual({ debugServer: "localhost:6006", project: "/p/game" });
    const custom = remoteAttachConfig(configOf(remote.godotAttachType, { port: "6010" }), "/p")!;
    expect(JSON.parse(custom.extraJson!).debugServer).toBe("localhost:6010");
  });

  it("Attach to Node.js attaches js-debug to the inspector with local/remote roots", () => {
    const l = remoteAttachConfig(configOf(nodeRemoteType, { host: "web", remoteRoot: "/usr/src/app" }), "/p")!;
    expect(l.adapter).toBe("js-debug");
    expect(JSON.parse(l.extraJson!)).toMatchObject({
      type: "pwa-node",
      address: "web",
      port: 9229,
      localRoot: "/p",
      remoteRoot: "/usr/src/app",
    });
  });

  it("start-the-remote-side hints follow the port", () => {
    expect(remote.delveServerCommand({ port: "4000" })).toBe(
      "dlv debug --headless --listen=:4000 --api-version=2 --accept-multiclient",
    );
    expect(remote.debugpyServerCommand({ port: "5679" })).toContain("--listen 0.0.0.0:5679");
    expect(remote.nodeInspectCommand({})).toBe("node --inspect=0.0.0.0:9229 app.js");
  });
});
