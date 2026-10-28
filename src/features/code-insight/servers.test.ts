import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerId, ServerInfo } from "@/bindings";

const pending = vi.hoisted(() => [] as ((data: ServerInfo[]) => void)[]);

vi.mock("@/platform/ipc", async (importOriginal) => {
  const ipc = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...ipc,
    isTauri: () => true,
    commands: {
      ...ipc.commands,
      lspServers: () =>
        new Promise((resolve) => {
          pending.push((data) => resolve({ status: "ok", data }));
        }),
    },
  };
});

const { emitLocalIdeEvent } = await import("@/platform/ipc");
const { useProject } = await import("@/platform/project");
const { installServerEvents, serversSummary, useServers } = await import("./servers");

describe("server status", () => {
  let dispose = () => {};
  afterEach(() => dispose());

  it("keeps a status that arrived after the snapshot was requested", async () => {
    useProject.setState({ project: { name: "p", root: "/p", isGit: false, settings: {} } as never });
    dispose = installServerEvents();
    const id = 1 as ServerId;
    const info: ServerInfo = { id, name: "jdtls", languages: [], root: "/p", status: "starting", pid: null };
    // The first event requests a snapshot; the server reports missing before it answers.
    emitLocalIdeEvent({ type: "languageServer", server: id, name: "jdtls", status: "starting", message: null });
    emitLocalIdeEvent({ type: "languageServer", server: id, name: "jdtls", status: "missing", message: "install jdtls" });
    pending.splice(0).forEach((resolve) => resolve([info]));
    await vi.waitFor(() => expect(useServers.getState().servers.get(id)?.languages).toEqual([]));
    await new Promise((r) => setTimeout(r, 0));
    expect(useServers.getState().servers.get(id)).toMatchObject({ status: "missing", message: "install jdtls" });
  });

  it("drops a server the backend removed, even if an older snapshot still lists it", async () => {
    useProject.setState({ project: { name: "p", root: "/p", isGit: false, settings: {} } as never });
    dispose = installServerEvents();
    const info = (id: number, name: string): ServerInfo => ({
      id: id as ServerId,
      name,
      languages: ["python"],
      root: "/p",
      status: "ready",
      pid: null,
    });
    pending.splice(0).forEach((resolve) => resolve([info(11, "basedpyright"), info(12, "pyright")]));
    await vi.waitFor(() => expect(useServers.getState().servers.size).toBe(2));
    expect(serversSummary([...useServers.getState().servers.values()])?.text).toBe("basedpyright +1");

    // The fallback stops and leaves the list; a snapshot taken before that answers late.
    const status = (id: number, name: string, status: ServerInfo["status"]) =>
      emitLocalIdeEvent({ type: "languageServer", server: id as ServerId, name, status, message: null });
    status(13, "ty", "starting");
    status(12, "pyright", "stopped");
    emitLocalIdeEvent({ type: "languageServerRemoved", server: 12 as ServerId });
    expect(useServers.getState().servers.has(12 as ServerId)).toBe(false);
    pending.splice(0).forEach((resolve) => resolve([info(11, "basedpyright"), info(12, "pyright"), info(13, "ty")]));
    await vi.waitFor(() => expect(useServers.getState().servers.get(13 as ServerId)?.languages).toEqual(["python"]));
    expect([...useServers.getState().servers.keys()]).toEqual([11, 13]);

    emitLocalIdeEvent({ type: "languageServerRemoved", server: 13 as ServerId });
    expect(serversSummary([...useServers.getState().servers.values()])?.text).toBe("basedpyright");
  });
});

describe("serversSummary", () => {
  const entry = (id: number, name: string, status: ServerInfo["status"]) => ({
    id: id as ServerId,
    name,
    status,
    message: null,
    languages: ["typescript"],
    root: "/p",
  });
  it("doesn't flag a missing server whose languages another one serves", () => {
    expect(serversSummary([entry(1, "vtsls", "missing"), entry(2, "typescript-language-server", "ready")])?.tone).toBe("ok");
    expect(serversSummary([entry(1, "vtsls", "missing")])?.tone).toBe("error");
  });
  it("doesn't count stopped servers next to running ones", () => {
    const text = (...servers: ReturnType<typeof entry>[]) => serversSummary(servers)?.text;
    expect(text(entry(1, "basedpyright", "ready"), entry(2, "pyright", "stopped"))).toBe("basedpyright");
    expect(text(entry(1, "basedpyright", "ready"), entry(2, "ty", "starting"))).toBe("basedpyright +1");
    expect(serversSummary([entry(2, "pyright", "stopped")])).toMatchObject({ text: "pyright", tone: "idle" });
  });
});
