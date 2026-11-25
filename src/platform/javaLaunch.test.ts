import { beforeEach, expect, it, vi } from "vitest";
import type { CapabilityInfo, PluginInfo } from "@/platform/ipc";

const state = vi.hoisted(() => ({ remote: false, plugins: [] as unknown[] }));
vi.mock("@/platform/remote", () => ({ isRemoteWindow: () => state.remote }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      pluginList: vi.fn(() => Promise.resolve({ status: "ok", data: { plugins: state.plugins } })),
    },
  };
});

const { remoteJavaAgentNote } = await import("./javaLaunch");

function plugin(name: string, enabled: boolean, granted: boolean | null): PluginInfo {
  const capabilities: CapabilityInfo[] =
    granted === null ? [] : [{ id: "java.agent", risk: "high", description: "", optional: true, granted }];
  return { name, enabled, capabilities } as unknown as PluginInfo;
}

beforeEach(() => {
  state.remote = true;
  state.plugins = [
    plugin("Spring Agent", true, true),
    plugin("Refused", true, false),
    plugin("Off", false, true),
    plugin("Theme", true, null),
  ];
});

it("says once that a remote Java launch got no agent, naming the plugins with a granted one", async () => {
  for (const kind of ["application", "spring-boot", "jar-application"]) {
    expect(await remoteJavaAgentNote({ kind })).toBe(
      "Java agents of Spring Agent were not added: they load only in local projects.\n",
    );
  }
});

it("says nothing for local projects, other kinds, or without a granted agent", async () => {
  expect(await remoteJavaAgentNote({ kind: "maven" })).toBeNull();
  expect(await remoteJavaAgentNote({ kind: "junit" })).toBeNull();
  state.remote = false;
  expect(await remoteJavaAgentNote({ kind: "application" })).toBeNull();
  state.remote = true;
  state.plugins = [plugin("Refused", true, false)];
  expect(await remoteJavaAgentNote({ kind: "application" })).toBeNull();
});
