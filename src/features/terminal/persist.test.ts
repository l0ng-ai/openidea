import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode } from "./persist";
import { useProject } from "@/platform/project";
import {
  closeAll,
  getSession,
  layoutGroups,
  newTab,
  renameTab,
  splitTab,
  syncTerminalProject,
  unbindTerminals,
  useTerminals,
} from "./store";

vi.mock("./session", () => ({
  TerminalSession: class {
    key: string;
    state: { cwd: string; status: string; terminalId?: number | null };
    command:
      | { program: string; args: string[]; shell?: boolean; onExit?: (code: number | null, closed: boolean) => void }
      | undefined;
    fallbackRoot: string | undefined;
    attachTerminalId: number | null | undefined;
    disposedWithKill: boolean | undefined;
    constructor(opts: {
      key: string;
      cwd: string;
      command?: {
        program: string;
        args: string[];
        shell?: boolean;
        onExit?: (code: number | null, closed: boolean) => void;
      };
      fallbackRoot?: string;
      attachTerminalId?: number | null;
    }) {
      this.key = opts.key;
      this.state = { cwd: opts.cwd, status: "idle", terminalId: opts.attachTerminalId ?? null };
      this.command = opts.command;
      this.fallbackRoot = opts.fallbackRoot;
      this.attachTerminalId = opts.attachTerminalId;
    }
    get persistedTerminalId() {
      return this.state.terminalId ?? this.attachTerminalId ?? null;
    }
    async start() {
      this.state.status = "running";
    }
    dispose(kill = true) {
      this.disposedWithKill = kill;
      if (kill) this.command?.onExit?.(null, true);
    }
  },
}));

vi.mock("./runtime", async () => await vi.importActual("./store"));

const state = () => useTerminals.getState();
const names = () => state().tabs.map((t) => t.customName ?? t.name);
const sessionOf = (key: string) =>
  getSession(key) as
    | { state: { cwd: string }; command?: { program: string; args: string[]; shell?: boolean }; fallbackRoot?: string }
    | undefined;

beforeEach(() => {
  unbindTerminals();
  localStorage.clear();
  closeAll();
});

afterEach(() => useProject.setState({ project: null }));

describe("terminal tab memory", () => {
  it("keeps a plugin terminal opened before the terminal pane first mounts", async () => {
    useProject.setState({ project: { root: "/lazy-project" } } as never);
    const { loadTerminalRuntime } = await import("./loader");
    const runtime = await loadTerminalRuntime();
    const onExit = vi.fn();
    await runtime.pluginSession({
      kind: "terminal",
      operation: "first-plugin-terminal",
      title: "Wrapper",
      program: "/approved/wrapper",
      cwd: "/lazy-project",
      onExit,
    });
    const tab = state().tabs[0]!;
    const session = getSession(tab.session);
    runtime.syncTerminalProject("/lazy-project");
    expect(getSession(tab.session)).toBe(session);
    expect(state().tabs).toContainEqual(tab);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("rejects a stored value that is not this version", () => {
    expect(decode(null)).toBeNull();
    expect(decode({ v: 2, tabs: [], layout: "g" })).toBeNull();
    expect(decode({ v: 1, tabs: [{}], layout: "g" })).toMatchObject({ tabs: [] });
    expect(decode({ v: 1, tabs: "nope", layout: "g" })).toBeNull();
  });

  it("restores each project's tabs, working directories, renames and splits", () => {
    syncTerminalProject("/repo");
    const app = newTab("/repo");
    renameTab(app.id, "Server");
    const logs = newTab("/repo/logs");
    const side = splitTab(logs.id, "horizontal")!;
    expect(state().activeTab).toBe(side);
    getSession(logs.session)!.state.cwd = "/repo/logs/today";
    useTerminals.setState((s) => ({
      sessions: { ...s.sessions, [logs.session]: { ...s.sessions[logs.session]!, cwd: "/repo/logs/today" } },
    }));

    syncTerminalProject("/other");
    expect(state().tabs).toEqual([]);
    newTab("/other");

    syncTerminalProject("/repo");
    expect(names()).toEqual(["Server", "Local (2)", "Local (3)"]);
    const restored = state().tabs;
    expect(getSession(restored[0]!.session)?.state.cwd).toBe("/repo");
    expect(getSession(restored[1]!.session)?.state.cwd).toBe("/repo/logs/today");
    expect(getSession(restored[2]!.session)?.state.cwd).toBe("/repo/logs");
    expect(layoutGroups(state().layout)).toHaveLength(2);
    expect(restored[2]!.group).not.toBe(restored[1]!.group);
    expect(state().activeTab).toBe(restored[2]!.id);

    syncTerminalProject("/other");
    expect(names()).toEqual(["Local"]);
    expect(getSession(state().tabs[0]!.session)?.state.cwd).toBe("/other");
  });

  it("reopens a predefined shell, and a one-shot command as a plain shell in the same directory", () => {
    syncTerminalProject("/repo");
    newTab("/repo", "zsh", { program: "/bin/zsh", args: [], shell: true });
    newTab("/repo/app", "build", { program: "npm", args: ["test"] });
    syncTerminalProject(null);
    syncTerminalProject("/repo");
    const [shell, command] = state().tabs;
    const started = (key: string) =>
      getSession(key) as { command?: { program: string; args: string[]; shell?: boolean } } | undefined;
    expect(started(shell!.session)?.command).toEqual({ program: "/bin/zsh", args: [], shell: true });
    expect(started(command!.session)?.command).toBeUndefined();
    expect(getSession(command!.session)?.state.cwd).toBe("/repo/app");
    expect(command!.name).toBe("build");
  });

  it("keeps the saved tabs when the terminal runtime is dropped", () => {
    syncTerminalProject("/repo");
    const tab = newTab("/repo");
    renameTab(tab.id, "Ship");
    unbindTerminals();
    expect(state().tabs).toEqual([]);
    syncTerminalProject("/repo");
    expect(names()).toEqual(["Ship"]);
    expect(getSession(state().tabs[0]!.session)?.state.cwd).toBe("/repo");
  });

  it("restored tabs fall back to the project root, fresh tabs do not", () => {
    syncTerminalProject("/repo");
    newTab("/repo/logs");
    syncTerminalProject(null);
    syncTerminalProject("/repo");
    const restored = state().tabs[0]!;
    expect(sessionOf(restored.session)?.fallbackRoot).toBe("/repo");

    const fresh = newTab("/repo/app");
    expect(sessionOf(fresh.session)?.fallbackRoot).toBeUndefined();

    const side = splitTab(restored.id, "horizontal")!;
    const sideTab = state().tabs.find((t) => t.id === side)!;
    expect(sessionOf(sideTab.session)?.fallbackRoot).toBe("/repo");
  });

  it("restores a tab whose saved directory is gone with the project root as its fallback", () => {
    syncTerminalProject("/repo");
    const tab = newTab("/repo");
    getSession(tab.session)!.state.cwd = "/repo/gone";
    useTerminals.setState((s) => ({
      sessions: { ...s.sessions, [tab.session]: { ...s.sessions[tab.session]!, cwd: "/repo/gone" } },
    }));

    syncTerminalProject(null);
    syncTerminalProject("/repo");
    const restored = sessionOf(state().tabs[0]!.session)!;
    expect(restored.state.cwd).toBe("/repo/gone");
    expect(restored.fallbackRoot).toBe("/repo");
  });

  it("reattaches live remote terminal ids without killing them on unbind and keeps two remote hosts apart", () => {
    const scopeA = "ssh://devbox-a/home/coder/repo";
    const scopeB = "ssh://devbox-b/home/coder/repo";

    syncTerminalProject("/home/coder/repo", scopeA);
    const tabA = newTab("/home/coder/repo");
    renameTab(tabA.id, "watch date");
    const sessionA = getSession(tabA.session) as unknown as {
      state: { cwd: string; terminalId: number | null };
      disposedWithKill?: boolean;
    };
    sessionA.state.terminalId = 41;
    useTerminals.setState((s) => ({
      sessions: { ...s.sessions, [tabA.session]: { ...s.sessions[tabA.session]!, terminalId: 41 } },
    }));

    // Leaving a remote project detaches without killing the remote PTY.
    unbindTerminals();
    expect(sessionA.disposedWithKill).toBe(false);

    // Another remote host with the same `/home/coder/repo` path has its own tab layout.
    syncTerminalProject("/home/coder/repo", scopeB);
    expect(state().tabs).toEqual([]);
    const tabB = newTab("/home/coder/repo");
    renameTab(tabB.id, "docker compose");

    // Reopening `devbox-a` restores `watch date` and reattaches to PTY 41.
    syncTerminalProject("/home/coder/repo", scopeA);
    expect(names()).toEqual(["watch date"]);
    const restoredA = getSession(state().tabs[0]!.session) as unknown as {
      attachTerminalId?: number | null;
      state: { status: string };
    };
    expect(restoredA.attachTerminalId).toBe(41);
    expect(restoredA.state.status).toBe("running");
  });
});
