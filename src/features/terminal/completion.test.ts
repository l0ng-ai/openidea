/**
 * Finished terminal commands (#3712): the completion policy (Settings ›
 * Notifications › Terminal) decides per finished shell-integration command;
 * the session reports C → D with the exit status and Ctrl-C stops; the store
 * wires the decision to a notification and the tab's unseen marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { completionAlert, completionPrefs } from "./completion";
import { newTab, useTerminals, closeAll, getSession } from "./store";
import { TerminalSession } from "./session";

const ipc = vi.hoisted(() => ({
  call: vi.fn(async (v: unknown) => v),
  commands: {
    fsReadDir: vi.fn(),
    fsEntryKind: vi.fn(),
    findFiles: vi.fn(),
    termSpawn: vi.fn(),
    termKill: vi.fn(),
    termResize: vi.fn(),
    termIsBusy: vi.fn(),
    termWrite: vi.fn(),
  },
}));
const workbench = vi.hoisted(() => ({
  notify: vi.fn(),
  visible: false,
  show: vi.fn(),
}));

vi.mock("@/platform/ipc", () => ({ call: ipc.call, commands: ipc.commands, isTauri: () => true }));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifications: () => ({ notify: workbench.notify }),
  toolWindowService: () => ({ isVisible: () => workbench.visible, show: workbench.show, hide: vi.fn() }),
}));
// `Channel` needs the Tauri runtime; a start() test only hands it to the mocked spawn call.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Channel: class {
    onmessage: ((chunk: string) => void) | null = null;
  },
}));

const write = (session: TerminalSession, data: string) =>
  new Promise<void>((resolve) => session.term.write(data, resolve));

const info = (over: Partial<Parameters<typeof completionAlert>[1]> = {}) => ({
  durationMs: 60_000,
  exitCode: 0,
  interrupted: false,
  ...over,
});

describe("completion policy", () => {
  const long = { mode: "longRunning" as const, thresholdMs: 10_000 };

  it("notifies for a long-running command when the tab cannot be seen", () => {
    expect(completionAlert(long, info(), false)).toEqual({ level: "info", body: "Finished" });
    expect(completionAlert(long, info(), true)).toBeNull();
  });

  it("keeps short commands and the shell's first prompt quiet", () => {
    expect(completionAlert(long, info({ durationMs: 9_999 }), false)).toBeNull();
    expect(completionAlert(long, info({ durationMs: 10_000 }), false)).toEqual({ level: "info", body: "Finished" });
  });

  it("reports a failure's exit code however briefly it ran", () => {
    expect(completionAlert(long, info({ durationMs: 200, exitCode: 1 }), false)).toEqual({
      level: "warning",
      body: "Exited with code 1",
    });
    // No exit status sent: not a known failure, so the long-running gate applies.
    expect(completionAlert(long, info({ durationMs: 200, exitCode: null }), false)).toBeNull();
  });

  it("never notifies when the mode is off, the command was stopped, or the tab is watched", () => {
    const off = { mode: "off" as const, thresholdMs: 10_000 };
    expect(completionAlert(off, info({ exitCode: 1 }), false)).toBeNull();
    expect(completionAlert(long, info({ interrupted: true, exitCode: 130 }), false)).toBeNull();
    expect(completionAlert({ mode: "all", thresholdMs: 10_000 }, info(), true)).toBeNull();
  });

  it("mode all notifies for every seen finish, short ones included", () => {
    const all = { mode: "all" as const, thresholdMs: 10_000 };
    expect(completionAlert(all, info({ durationMs: 50 }), false)).toEqual({ level: "info", body: "Finished" });
  });

  it("defaults to long-running with a 10 s threshold", () => {
    expect(completionPrefs()).toEqual({ mode: "longRunning", thresholdMs: 10_000 });
  });

  it.each([
    [
      { terminalCompletion: "all", terminalThresholdSeconds: 5 },
      { mode: "all", thresholdMs: 5_000 },
    ],
    [{ terminalCompletion: "off" }, { mode: "off", thresholdMs: 10_000 }],
    [
      { terminalCompletion: "sometimes", terminalThresholdSeconds: 0 },
      { mode: "longRunning", thresholdMs: 10_000 },
    ],
  ] as const)("reads the settings %o as %o", (notifications, expected) => {
    useProject.setState({ settings: { notifications } as unknown as Settings });
    expect(completionPrefs()).toEqual(expected);
  });
});

describe("command completion detection", () => {
  beforeEach(() => {
    useProject.setState({ settings: { notifications: { terminalCompletion: "all" } } as unknown as Settings });
  });
  afterEach(() => {
    closeAll();
    useProject.setState({ project: null, settings: null });
    vi.clearAllMocks();
  });

  const feed = async (session: TerminalSession, ...chunks: string[]) => {
    for (const chunk of chunks) await write(session, chunk);
  };

  it("reports C → D with the exit status once", async () => {
    const onCompletion = vi.fn();
    const session = new TerminalSession({ key: "k1", cwd: "/repo", onChange() {}, onFocus() {}, onCompletion });
    try {
      // The shell's first prompt is a bare D: no command ran, nothing is reported.
      await feed(session, "\x1b]133;D;0\x07");
      expect(onCompletion).not.toHaveBeenCalled();
      await feed(session, "\x1b]133;C\x07", "\x1b]133;D;3\x07");
      expect(onCompletion).toHaveBeenCalledExactlyOnceWith("k1", expect.objectContaining({ exitCode: 3 }));
      expect(session.state).toMatchObject({ commandRunning: false });
    } finally {
      session.dispose();
    }
  });

  it("accepts the status-less D and clears the unseen marker when a new command starts", async () => {
    const session = new TerminalSession({ key: "k2", cwd: "/repo", onChange() {}, onFocus() {} });
    try {
      await feed(session, "\x1b]133;C\x07", "\x1b]133;D\x07");
      expect(session.state).toMatchObject({ commandRunning: false });
      session.markUnseenDone();
      expect(session.state.unseenDone).toBe(true);
      await feed(session, "\x1b]133;C\x07");
      expect(session.state).toMatchObject({ commandRunning: true, unseenDone: false });
    } finally {
      session.dispose();
    }
  });

  it("does not count a command stopped with Ctrl-C as finished", async () => {
    const onCompletion = vi.fn();
    const session = new TerminalSession({ key: "k3", cwd: "/repo", onChange() {}, onFocus() {}, onCompletion });
    try {
      ipc.commands.termSpawn.mockImplementationOnce(async () => ({ id: 42, title: "zsh" }));
      await session.start();
      await feed(session, "\x1b]133;C\x07");
      session.input("\x03");
      await write(session, "");
      await feed(session, "\x1b]133;D;130\x07");
      expect(onCompletion).toHaveBeenCalledExactlyOnceWith(
        "k3",
        expect.objectContaining({ exitCode: 130, interrupted: true }),
      );
    } finally {
      session.dispose();
    }
  });
});

describe("completion notification wiring", () => {
  const hasFocus = vi.spyOn(document, "hasFocus");

  beforeEach(() => {
    hasFocus.mockReturnValue(false);
    useProject.setState({ settings: { notifications: { terminalCompletion: "all" } } as unknown as Settings });
  });
  afterEach(() => {
    closeAll();
    useProject.setState({ project: null, settings: null });
    vi.clearAllMocks();
    workbench.visible = false;
  });

  /** A tab with a session whose shell integration reports a finished command. */
  const finishedTab = async (exitStatus: string) => {
    const tab = newTab("/repo");
    const session = getSession(tab.session)!;
    await write(session, `\x1b]133;C\x07`);
    await write(session, `\x1b]133;D${exitStatus}\x07`);
    return tab;
  };

  it("notifies once per tab, marks it unseen, and Show focuses the tab", async () => {
    const tab = await finishedTab(";0");
    expect(workbench.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        group: "terminal",
        level: "info",
        key: `terminal-done-${tab.session}`,
        title: tab.name,
        body: "Finished",
        actions: [expect.objectContaining({ label: "Show" })],
      }),
    );
    expect(useTerminals.getState().sessions[tab.session]?.unseenDone).toBe(true);
    // The next command replaces the notice instead of piling up.
    const session = getSession(tab.session)!;
    await write(session, "\x1b]133;C\x07");
    await write(session, "\x1b]133;D;2\x07");
    expect(workbench.notify).toHaveBeenCalledTimes(2);
    expect(workbench.notify.mock.calls[1]![0]).toMatchObject({ key: `terminal-done-${tab.session}`, level: "warning" });
    // The action selects the tab, shows the tool window and focuses the session.
    workbench.notify.mock.calls[0]![0].actions[0].run();
    expect(workbench.show).toHaveBeenCalledWith("terminal", true);
    expect(useTerminals.getState().activeTab).toBe(tab.id);
    // The focus lands one frame later, after the tool window's pane re-mounts.
    await new Promise((r) => requestAnimationFrame(r));
    expect(useTerminals.getState().sessions[tab.session]?.unseenDone).toBe(false);
  });

  it("stays quiet while the tab is watched", async () => {
    hasFocus.mockReturnValue(true);
    workbench.visible = true;
    const tab = await finishedTab(";0");
    const state = useTerminals.getState();
    expect(state.selected[state.tabs.find((t) => t.id === tab.id)!.group]).toBe(tab.id);
    expect(workbench.notify).not.toHaveBeenCalled();
    expect(useTerminals.getState().sessions[tab.session]?.unseenDone).toBe(false);
  });

  it("mode off silences everything", async () => {
    useProject.setState({
      settings: { notifications: { terminalCompletion: "off" } } as unknown as Settings,
    });
    const tab = await finishedTab(";0");
    expect(workbench.notify).not.toHaveBeenCalled();
    expect(useTerminals.getState().sessions[tab.session]?.unseenDone).toBe(false);
  });

  it("a failure notifies however briefly it ran", async () => {
    useProject.setState({
      settings: { notifications: { terminalCompletion: "longRunning" } } as unknown as Settings,
    });
    await finishedTab(";1");
    expect(workbench.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ group: "terminal", level: "warning" }),
    );
  });
});
