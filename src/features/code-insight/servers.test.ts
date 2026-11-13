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
const { BUSY_SHOW_DELAY_MS, eslintCovers, installServerEvents, serversSummary, useServers } = await import("./servers");

describe("server status", () => {
  let dispose = () => {};
  afterEach(() => dispose());

  it("keeps a status that arrived after the snapshot was requested", async () => {
    useProject.setState({ project: { name: "p", root: "/p", trusted: true, isGit: false, settings: {} } as never });
    dispose = installServerEvents();
    const id = 1 as ServerId;
    const info: ServerInfo = { id, name: "jdtls", languages: [], root: "/p", status: "starting", pid: null };
    // The first event requests a snapshot; the server reports missing before it answers.
    emitLocalIdeEvent({ type: "languageServer", server: id, name: "jdtls", status: "starting", message: null });
    emitLocalIdeEvent({
      type: "languageServer",
      server: id,
      name: "jdtls",
      status: "missing",
      message: "install jdtls",
    });
    pending.splice(0).forEach((resolve) => resolve([info]));
    await vi.waitFor(() => expect(useServers.getState().servers.get(id)?.languages).toEqual([]));
    await new Promise((r) => setTimeout(r, 0));
    expect(useServers.getState().servers.get(id)).toMatchObject({ status: "missing", message: "install jdtls" });
  });

  it("drops a server the backend removed, even if an older snapshot still lists it", async () => {
    useProject.setState({ project: { name: "p", root: "/p", trusted: true, isGit: false, settings: {} } as never });
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

  it("shows a running server busy only once it stays busy", async () => {
    vi.useFakeTimers();
    try {
      useProject.setState({ project: { name: "p", root: "/p", trusted: true, isGit: false, settings: {} } as never });
      dispose = installServerEvents();
      const id = 21 as ServerId;
      const status = (status: ServerInfo["status"]) =>
        emitLocalIdeEvent({ type: "languageServer", server: id, name: "jdtls", status, message: null });
      const shown = () => useServers.getState().servers.get(id)?.status;
      status("starting");
      expect(shown()).toBe("starting");
      status("ready");
      // A task of a few milliseconds, as jdtls reports on every edit: nothing changes.
      status("busy");
      vi.advanceTimersByTime(BUSY_SHOW_DELAY_MS - 1);
      status("ready");
      vi.advanceTimersByTime(BUSY_SHOW_DELAY_MS);
      expect(shown()).toBe("ready");
      // Work that goes on shows.
      status("busy");
      vi.advanceTimersByTime(BUSY_SHOW_DELAY_MS - 1);
      expect(shown()).toBe("ready");
      vi.advanceTimersByTime(1);
      expect(shown()).toBe("busy");
      status("ready");
      expect(shown()).toBe("ready");
      // Anything else shows at once, and replaces a pending busy.
      status("busy");
      status("crashed");
      expect(shown()).toBe("crashed");
      vi.advanceTimersByTime(BUSY_SHOW_DELAY_MS);
      expect(shown()).toBe("crashed");
    } finally {
      vi.useRealTimers();
    }
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
    expect(serversSummary([entry(1, "vtsls", "missing"), entry(2, "typescript-language-server", "ready")])?.tone).toBe(
      "ok",
    );
    expect(serversSummary([entry(1, "vtsls", "missing")])?.tone).toBe("error");
  });
  it("doesn't count stopped servers next to running ones", () => {
    const text = (...servers: ReturnType<typeof entry>[]) => serversSummary(servers)?.text;
    expect(text(entry(1, "basedpyright", "ready"), entry(2, "pyright", "stopped"))).toBe("basedpyright");
    expect(text(entry(1, "basedpyright", "ready"), entry(2, "ty", "starting"))).toBe("basedpyright +1");
    expect(serversSummary([entry(2, "pyright", "stopped")])).toMatchObject({ text: "pyright", tone: "idle" });
  });
});

describe("ESLint coverage", () => {
  afterEach(() => useServers.setState({ servers: new Map() }));

  it("covers files of its languages below its configuration while it runs", () => {
    const eslint = (status: "ready" | "starting", root: string | null) =>
      useServers.setState({
        servers: new Map([
          [1, { id: 1, name: "eslint", status, message: null, languages: ["javascript", "typescript"], root }],
        ]),
      });
    eslint("ready", "/p/web");
    expect(eslintCovers("/p/web/src/a.ts", "typescript")).toBe(true);
    expect(eslintCovers("/p/web/src/a.ts", "rust")).toBe(false);
    expect(eslintCovers("/p/api/a.ts", "typescript")).toBe(false);
    expect(eslintCovers("/p/webapp/a.ts", "typescript")).toBe(false);
    expect(eslintCovers("/p/web/src/a.ts", null)).toBe(false);
    eslint("starting", "/p/web");
    expect(eslintCovers("/p/web/src/a.ts", "typescript")).toBe(false);
    eslint("ready", "C:\\p\\web");
    expect(eslintCovers("C:\\p\\web\\a.js", "javascript")).toBe(true);
  });
});
