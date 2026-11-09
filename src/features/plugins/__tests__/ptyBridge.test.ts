import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalId, TerminalInfo } from "@/bindings";
import { ptyBridge, type PtyBackend } from "../views/ptyBridge";

const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) close();
  await tick();
});
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function setup(plugin = "acme.pty") {
  let output: (data: string) => void = () => {};
  let exit: (id: TerminalId, code: number | null) => void = () => {};
  let serial = 0;
  const backend: PtyBackend = {
    spawn: vi.fn(async (_command, listener) => {
      output = listener;
      return { id: ++serial as TerminalId } as TerminalInfo;
    }),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    onExit: (listener) => {
      exit = listener;
      return vi.fn();
    },
  };
  const sent: Record<string, unknown>[] = [];
  const bridge = ptyBridge(plugin, backend, (m) => sent.push(m as Record<string, unknown>));
  cleanup.push(bridge.close);
  const send = (m: object) => bridge.handle(JSON.stringify({ sessionId: "s", ...m }));
  const spawn = () => send({ op: "pty-spawn", program: "bash", args: ["-i"] });
  return {
    backend,
    sent,
    bridge,
    send,
    spawn,
    output: (data: string) => output(data),
    exit: (id: number, code: number | null) => exit(id as TerminalId, code),
  };
}

describe("web frame PTY ownership and limits", () => {
  it("rejects malformed types, sizes, paths and dimensions without starting a process", () => {
    const f = setup();
    for (const bad of [
      { program: "\0" },
      { program: " bash" },
      { args: [1] },
      { args: ["x".repeat(4097)] },
      { args: Array(257).fill("x") },
      { args: ["\0"] },
      { cols: -1 },
      { rows: 501 },
      { cols: 2.5 },
      { cols: "80" },
      { env: [] },
      { env: { PATH: 1 } },
      { env: { "a=b": "v" } },
      { env: { a: "\0" } },
      { cwd: "/" },
      { sessionId: "x".repeat(65) },
    ])
      f.send({ op: "pty-spawn", program: "bash", ...bad });
    expect(f.backend.spawn).not.toHaveBeenCalled();
    expect(f.bridge.handle("null")).toBe(false);
    expect(f.bridge.handle("[1]")).toBe(false);
    expect(f.bridge.handle("garbage")).toBe(false);
    expect(f.bridge.handle(JSON.stringify({ op: "plugin-state", data: "x".repeat(3 << 20) }))).toBe(false);
    f.send({ op: "pty-spawn", program: "bash", padding: "x".repeat(3 << 20) });
    expect(f.sent.every((m) => m.op === "pty-error")).toBe(true);
  });

  it("caps sessions across frames of one plugin, including cancelled pending starts", async () => {
    const a = setup();
    const b = setup();
    const other = setup("other.pty");
    const resolves: Array<(info: TerminalInfo) => void> = [];
    vi.mocked(a.backend.spawn).mockImplementation(
      () =>
        new Promise((r) => {
          resolves.push(r);
        }),
    );
    for (let i = 0; i < 8; i++) a.send({ op: "pty-spawn", program: "bash", sessionId: `s${i}` });
    b.spawn();
    expect(b.backend.spawn).not.toHaveBeenCalled();
    a.send({ op: "pty-kill", sessionId: "s7" });
    b.spawn();
    expect(b.backend.spawn).not.toHaveBeenCalled();
    other.spawn();
    expect(other.backend.spawn).toHaveBeenCalledOnce();
    resolves[7]!({ id: 77 as TerminalId } as TerminalInfo);
    await tick();
    expect(a.backend.kill).toHaveBeenCalledWith(77);
    b.spawn();
    await tick();
    expect(b.backend.spawn).toHaveBeenCalledOnce();
    // Finish the other pending starts so their reservations cannot leak between tests.
    a.bridge.close();
    for (let i = 0; i < 7; i++) resolves[i]!({ id: (80 + i) as TerminalId } as TerminalInfo);
    await tick();
  });

  it("serializes bounded pending and in-flight input and coalesces resizes", async () => {
    const f = setup();
    let resolve!: (info: TerminalInfo) => void;
    vi.mocked(f.backend.spawn).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    f.spawn();
    f.send({ op: "pty-input", data: "hello" });
    f.send({ op: "pty-resize", cols: 90, rows: 30 });
    f.send({ op: "pty-resize", cols: 100, rows: 40 });
    resolve({ id: 1 as TerminalId } as TerminalInfo);
    await tick();
    expect(f.backend.write).toHaveBeenCalledWith(1, "hello");
    expect(f.backend.resize).toHaveBeenCalledExactlyOnceWith(1, 100, 40);
    vi.mocked(f.backend.write).mockImplementation(() => new Promise(() => {}));
    f.send({ op: "pty-input", data: "x".repeat(64 << 10) });
    f.send({ op: "pty-input", data: "x" });
    await tick();
    expect(f.backend.kill).toHaveBeenCalledWith(1);
    expect(f.sent.at(-1)?.error).toBe("PTY input limit exceeded");
  });

  it("never lets one frame write, resize or kill another frame's terminals", async () => {
    const a = setup("ownership.pty");
    const b = setup("ownership.pty");
    a.spawn();
    await tick();
    b.send({ op: "pty-input", data: "bad" });
    b.send({ op: "pty-resize", cols: 80, rows: 24 });
    b.send({ op: "pty-kill" });
    expect(a.backend.write).not.toHaveBeenCalled();
    expect(a.backend.resize).not.toHaveBeenCalled();
    expect(a.backend.kill).not.toHaveBeenCalled();
    a.send({ op: "pty-input", data: "yes" });
    await tick();
    expect(a.backend.write).toHaveBeenCalledWith(1, "yes");
  });

  it("allows one unacknowledged chunk and caps all outstanding output", async () => {
    const f = setup("output.pty");
    f.spawn();
    await tick();
    f.output("hello");
    f.output("world");
    expect(f.sent).toHaveLength(1);
    f.send({ op: "pty-ack", sequence: 999 });
    expect(f.sent).toHaveLength(1);
    f.send({ op: "pty-ack", sequence: 1 });
    expect(f.sent.at(-1)).toMatchObject({ data: "world", sequence: 2 });
    f.output("x".repeat(256 << 10));
    await tick();
    expect(f.backend.kill).toHaveBeenCalledWith(1);
    expect(f.sent.at(-1)?.error).toBe("PTY output limit exceeded");
  });

  it("handles output and exit before spawn resolves and drains before reporting exit", async () => {
    const f = setup("early.pty");
    vi.mocked(f.backend.spawn).mockImplementation(async (_command, output) => {
      output("early");
      f.exit(42, 7);
      return { id: 42 as TerminalId } as TerminalInfo;
    });
    f.spawn();
    await tick();
    expect(f.sent).toHaveLength(1);
    f.send({ op: "pty-ack", sequence: 1 });
    expect(f.sent.at(-1)).toEqual({ op: "pty-exit", sessionId: "s", exitCode: 7 });
    f.spawn();
    await tick();
    expect(f.backend.spawn).toHaveBeenCalledTimes(2);
  });

  it("cleans failed and late spawns, catches operation failures and closes idempotently", async () => {
    const f = setup("cleanup.pty");
    vi.mocked(f.backend.spawn).mockRejectedValueOnce(new Error("denied"));
    f.spawn();
    await tick();
    f.spawn();
    await tick();
    expect(f.backend.spawn).toHaveBeenCalledTimes(2);
    vi.mocked(f.backend.resize).mockRejectedValueOnce(new Error("gone"));
    f.send({ op: "pty-resize", cols: 80, rows: 24 });
    await tick();
    expect(f.backend.kill).toHaveBeenCalledWith(1);
    let resolve!: (info: TerminalInfo) => void;
    vi.mocked(f.backend.spawn).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    f.spawn();
    f.bridge.close();
    f.bridge.close();
    resolve({ id: 2 as TerminalId } as TerminalInfo);
    await tick();
    expect(f.backend.kill).toHaveBeenCalledWith(2);
    f.spawn();
    expect(f.backend.spawn).toHaveBeenCalledTimes(3);
  });
});
