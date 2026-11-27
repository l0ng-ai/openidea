import { beforeEach, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ runImportConfigs: vi.fn(), dockerRunEnv: vi.fn() }));
const docker = vi.hoisted(() => ({ loadSettings: vi.fn(), connections: vi.fn(), endpointOf: vi.fn() }));
const host = vi.hoisted(() => ({ os: vi.fn(() => "linux") }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: backend,
}));
vi.mock("../services/store", () => docker);
vi.mock("@/platform/remote", async (original) => ({
  ...(await original<typeof import("@/platform/remote")>()),
  hostOs: host.os,
}));

import type { RunConfig, RunImport } from "@/platform/ipc";
import { provideNotificationService } from "@/workbench/contributions";
import { dockerfileType } from "../services/runTypes";
import { importConfigs } from "./importConfigs";
import { missingParams } from "./types";

const parsed = (): RunConfig => ({
  id: "user:docker",
  name: "Docker",
  kind: "docker-dockerfile",
  command: "",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  local: true,
  params: {
    dockerfile: "docker files/Dockerfile",
    tag: "sample/app:latest",
    containerName: "sample-container",
    serverName: "Remote Docker",
    runImage: "true",
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  provideNotificationService({ notify: vi.fn() });
  docker.loadSettings.mockResolvedValue(undefined);
  docker.connections.mockReturnValue([{ id: "remote-id", name: "Remote Docker" }]);
  host.os.mockReturnValue("linux");
  backend.runImportConfigs.mockImplementation(async () => ({
    status: "ok",
    data: {
      source: "jetbrains",
      file: ".run, .idea",
      imported: [{ config: parsed(), ignored: [] }],
      skipped: [],
    } satisfies RunImport,
  }));
});

it.each(["windows", "linux"])("imports a native Dockerfile configuration on %s", async (os) => {
  host.os.mockReturnValue(os);
  const configs = await importConfigs("jetbrains", []);
  const c = configs![0]!;
  expect(c.params?.connection).toBe("remote-id");
  expect(c.params?.tag).toBe("sample/app:latest");
  const native = dockerfileType.commandLine(c.params!)!;
  expect(c.command).toBe(native.command);
  expect(c.command).toContain("docker build");
  expect(c.command).toContain(os === "windows" ? '"docker files/Dockerfile"' : "'docker files/Dockerfile'");
  expect(c.command).toContain(os === "windows" ? ">nul 2>&1 &" : ">/dev/null 2>&1;");
  expect(c.command).toContain("docker run --name sample-container sample/app:latest");
  expect(c.stopCommand).toBe("docker stop sample-container");
  expect(c.local).toBe(true);
  expect(backend.dockerRunEnv).not.toHaveBeenCalled();
});

it.each([
  { connections: [] },
  { connections: [{ id: "other", name: "Other server" }] },
  {
    connections: [
      { id: "a", name: "Remote Docker" },
      { id: "b", name: "Remote Docker" },
    ],
  },
])("requires choosing a server when its name is missing or ambiguous: $connections", async ({ connections }) => {
  docker.connections.mockReturnValue(connections);
  const c = (await importConfigs("jetbrains", []))![0]!;
  expect(c.params?.connection).toBe("");
  expect(missingParams(c, dockerfileType)).toEqual({ connection: "Server is required" });
  await expect(dockerfileType.prepareLaunch!(c)).rejects.toThrow("Select a Docker server");
  expect(backend.dockerRunEnv).not.toHaveBeenCalled();
});

it("rejects a connection removed after import instead of falling back to the default daemon", async () => {
  const c = (await importConfigs("jetbrains", []))![0]!;
  docker.connections.mockReturnValue([]);
  await expect(dockerfileType.prepareLaunch!(c)).rejects.toThrow("Select a Docker server");
  expect(backend.dockerRunEnv).not.toHaveBeenCalled();
});

it("allows an explicitly selected default server after an unresolved import", async () => {
  docker.connections.mockReturnValue([]);
  const c = (await importConfigs("jetbrains", []))![0]!;
  c.params!.connection = "default";
  docker.endpointOf.mockReturnValue({ kind: "default" });
  backend.dockerRunEnv.mockResolvedValue({ status: "ok", data: { DOCKER_HOST: "unix:///example.sock" } });
  expect(missingParams(c, dockerfileType)).toEqual({});
  const prepared = await dockerfileType.prepareLaunch!(c);
  expect(prepared.env.DOCKER_HOST).toBe("unix:///example.sock");
});

it("does not resolve Docker settings for unrelated imports", async () => {
  const c = { ...parsed(), kind: "python", params: {}, command: "python" };
  backend.runImportConfigs.mockResolvedValue({
    status: "ok",
    data: { source: "jetbrains", file: ".run, .idea", imported: [{ config: c, ignored: [] }], skipped: [] },
  });
  expect(await importConfigs("jetbrains", [])).toEqual([c]);
  expect(docker.loadSettings).not.toHaveBeenCalled();
});
