/**
 * The PTY side of the CLI editor tabs (#2202): the backend spawns the user's
 * login shell (its default, no explicit program), the saved command is the
 * session's first input, and closing ends the PTY.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClis } from "./cli";
import {
  cliBusy,
  cliSession,
  cliSessionForTerminalId,
  cliSessionFromElement,
  disposeAllClis,
  disposeCli,
  startCli,
} from "./cliSessions";

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
vi.mock("@/platform/ipc", () => ({ call: ipc.call, commands: ipc.commands, isTauri: () => true }));
// `Channel` needs the Tauri runtime; the tests hand it to the mocked spawn call.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Channel: class {
    onmessage: ((chunk: string) => void) | null = null;
  },
}));

afterEach(() => {
  disposeAllClis();
  vi.clearAllMocks();
});

/** Starts a session's PTY, capturing the output channel for feeding OSC. */
const start = async (session: ReturnType<typeof startCli>) => {
  let onmessage: ((chunk: string) => void) | null = null;
  ipc.commands.termSpawn.mockImplementationOnce(
    async (_options: unknown, channel: { onmessage: ((chunk: string) => void) | null }) => {
      onmessage = (chunk) => channel.onmessage?.(chunk);
      return { id: 42, title: "zsh" };
    },
  );
  await session.start();
  return async (chunk: string) => {
    onmessage?.(chunk);
    // xterm parses the chunk asynchronously; flush before asserting on it.
    await new Promise<void>((resolve) => session.term.write("", resolve));
  };
};

describe("CLI sessions", () => {
  it("runs the saved command as the login shell's first input", async () => {
    const session = startCli("cli:t1", "/repo", "claude --continue");
    await start(session);
    // `shell: null` with no args is the backend's login-shell default (PATH, nvm, aliases).
    expect(ipc.commands.termSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", shell: null, args: [], shellIntegration: true }),
      expect.anything(),
    );
    expect(ipc.commands.termWrite).toHaveBeenCalledWith(42, "claude --continue\r");
    expect(session.state).toMatchObject({ status: "running", cwd: "/repo" });
    expect(useClis.getState().sessions["cli:t1"]).toMatchObject({ status: "running" });
  });

  it("opens a plain shell when the command is empty", async () => {
    const session = startCli("cli:t2", "/repo", "");
    await start(session);
    expect(ipc.commands.termSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }), expect.anything());
    expect(ipc.commands.termWrite).not.toHaveBeenCalled();
  });

  it("keeps one session per tab key", () => {
    const a = startCli("cli:t3", "/repo", "claude");
    expect(startCli("cli:t3", "/repo", "claude")).toBe(a);
    expect(ipc.commands.termSpawn).not.toHaveBeenCalled();
  });

  it("reports busy from shell integration, then from the backend", async () => {
    const session = startCli("cli:t4", "/repo", "codex");
    expect(await cliBusy("cli:t4")).toBe(false);
    const feed = await start(session);
    ipc.commands.termIsBusy.mockResolvedValue(false);
    expect(await cliBusy("cli:t4")).toBe(false);
    await feed("\x1b]133;C\x07");
    // The integration says a command runs: known without asking the backend.
    expect(cliBusy("cli:t4")).toBe(true);
    await feed("\x1b]133;D;0\x07");
    ipc.commands.termIsBusy.mockResolvedValue(true);
    expect(await cliBusy("cli:t4")).toBe(true);
    expect(await cliBusy("cli:gone")).toBe(false);
  });

  it("finds a session by its PTY and by the DOM it owns, and reports its exit", async () => {
    const session = startCli("cli:t5", "/repo", "claude");
    await start(session);
    expect(cliSessionForTerminalId(42)).toBe(session);
    expect(cliSessionFromElement(session.host)).toBe(session);
    session.exited(0);
    expect(session.state.status).toBe("exited");
  });

  it("ends the PTY and forgets the snapshot when its tab closes", async () => {
    const session = startCli("cli:t6", "/repo", "claude");
    await start(session);
    disposeCli("cli:t6");
    expect(ipc.commands.termKill).toHaveBeenCalledWith(42);
    expect(cliSession("cli:t6")).toBeUndefined();
    expect(useClis.getState().sessions["cli:t6"]).toBeUndefined();
  });

  it("ends every session when the project switches", async () => {
    const a = startCli("cli:t7", "/repo", "claude");
    const b = startCli("cli:t8", "/repo", "codex");
    await Promise.all([start(a), start(b)]);
    disposeAllClis();
    expect(ipc.commands.termKill).toHaveBeenCalledTimes(2);
    expect(useClis.getState().sessions).toEqual({});
  });
});
