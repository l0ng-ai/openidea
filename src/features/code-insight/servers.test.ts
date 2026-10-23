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
const { installServerEvents, useServers } = await import("./servers");

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
});
