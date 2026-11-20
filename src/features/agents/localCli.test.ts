import { afterEach, expect, it, vi } from "vitest";
import type { AgentProvider, IdeEvent, OutputChunk, RunId } from "@/bindings";
import { manageLocalCli } from "./localCli";

const api = vi.hoisted(() => ({
  sdkLocateTools: vi.fn(),
  agentLaunchProgram: vi.fn(),
  runStart: vi.fn(),
  runStop: vi.fn(),
  listen: vi.fn(),
  off: vi.fn(),
}));
vi.mock("@/platform/ipc", async (orig) => ({ ...(await orig<typeof import("@/platform/ipc")>()), commands: api }));
vi.mock("@tauri-apps/api/event", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/event")>()),
  listen: api.listen,
}));
vi.mock("@/platform/auxWindow", () => ({ auxiliaryWindow: () => ({ kind: "settings", parent: "project-2" }) }));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  Channel: class {},
}));
const agent = {
  id: "claude",
  source: { kind: "builtin" },
  installed: true,
  commandOverridden: false,
  env: {},
  program: "claude",
  defaultProgram: "claude",
} as AgentProvider;
const ok = <T>(data: T) => ({ status: "ok", data });
afterEach(() => vi.resetAllMocks());

it("passes the launcher's executable and collects a split reply when the exit event arrives first", async () => {
  api.sdkLocateTools.mockResolvedValue(
    ok({
      tools: [
        { name: "node", path: "/sys/bin/node" },
        { name: "npm", path: "/sys/bin/npm" },
      ],
    }),
  );
  api.agentLaunchProgram.mockResolvedValue(ok("/opt/npm/bin/claude"));
  let deliver!: (e: { payload: IdeEvent }) => void;
  api.listen.mockImplementation(async (_, cb) => {
    deliver = cb;
    return api.off;
  });
  api.runStart.mockImplementation(async (config, channel: { onmessage: (chunk: OutputChunk) => void }) => {
    expect(config).toMatchObject({
      command: "/sys/bin/node",
      cwd: "/sys/bin",
      target: "",
      emulateTerminal: false,
      env: {},
    });
    expect(JSON.parse(config.args.at(-1))).toMatchObject({
      program: "/opt/npm/bin/claude",
      pkg: "@anthropic-ai/claude-code",
    });
    deliver({ payload: { type: "runExited", run: 99 as RunId, code: 1 } });
    deliver({ payload: { type: "runExited", run: 12 as RunId, code: 0 } });
    setTimeout(() => {
      channel.onmessage({ kind: "stdout", text: '{"status":"current",' });
      channel.onmessage({ kind: "stdout", text: '"current":"1.1.0"}\n' });
    }, 0);
    return ok({ id: 12 });
  });
  await expect(manageLocalCli(agent)).resolves.toEqual({ status: "current", current: "1.1.0" });
  expect(api.listen.mock.calls[0]?.[2]).toEqual({ target: { kind: "WebviewWindow", label: "project-2" } });
  expect(api.off).toHaveBeenCalledOnce();
});

it("reports an agent without node and npm as not updatable", async () => {
  api.sdkLocateTools.mockResolvedValue(ok({ tools: [] }));
  api.agentLaunchProgram.mockResolvedValue(ok("/opt/npm/bin/claude"));
  await expect(manageLocalCli(agent)).resolves.toEqual({ status: "unmanaged" });
  expect(api.runStart).not.toHaveBeenCalled();
});
