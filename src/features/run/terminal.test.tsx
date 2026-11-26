import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  runStart: vi.fn((_config: unknown, _channel: unknown) =>
    Promise.resolve({
      status: "ok" as const,
      data: { id: 9, configId: "c", name: "c", pid: 1, running: true, pty: true },
    }),
  ),
  runStdin: vi.fn((_id: unknown, _data: unknown) => Promise.resolve({ status: "ok" as const, data: null })),
  runResize: vi.fn((_id: unknown, _c: unknown, _r: unknown) => Promise.resolve({ status: "ok" as const, data: null })),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import type { OutputChunk, RunConfig } from "@/platform/ipc";
import {
  provideEmbeddedTerminal,
  provideNotificationService,
  provideToolWindowService,
  registerRunConfigType,
  type EmbeddedTerminalOptions,
  type ToolWindowService,
} from "@/workbench/contributions";
import { optionPatch } from "./ConfigForm";
import { resetRuns, resizeTerminal, runtime, startRun, useRun, writeTerminal } from "./store";
import { TerminalConsole } from "./TerminalConsole";
import { TerminalOutput, terminalText } from "./terminalOutput";
import { terminalApplies, withParams } from "./types";

const config = (extra: Partial<RunConfig> = {}): RunConfig => ({
  id: "app",
  name: "app",
  kind: "shell",
  command: "top",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...extra,
});

const lastChannel = () => ipc.runStart.mock.calls.at(-1)![1] as { onmessage: (m: OutputChunk) => void };

beforeEach(() => {
  resetRuns();
  for (const f of Object.values(ipc)) f.mockClear();
  provideToolWindowService({ show: vi.fn(), isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify: () => undefined });
});
afterEach(() => provideEmbeddedTerminal(undefined));

describe("Emulate terminal in output console", () => {
  it("routes the output to the terminal and sends keystrokes and size as they are", async () => {
    const session = (await startRun(config({ emulateTerminal: true })))!;
    expect(session.terminal).toBe(true);
    const rt = runtime(session.id)!;
    lastChannel().onmessage({ kind: "stdout", text: "\x1b[1mhi\x1b[0m" });
    expect(rt.terminal!.text).toBe("\x1b[1mhi\x1b[0m");
    expect(rt.console.lines.length).toBe(0);

    writeTerminal(session.id, "q");
    expect(ipc.runStdin).toHaveBeenCalledWith(9, "q");
    resizeTerminal(session.id, 100, 40);
    expect(ipc.runResize).toHaveBeenCalledWith(9, 100, 40);
  });

  it("is never used for debug launches, and plain runs keep the console", async () => {
    const debug = (await startRun(config({ emulateTerminal: true }), undefined, undefined, {
      launch: config({ emulateTerminal: true }),
    }))!;
    expect(ipc.runStart.mock.calls[0]![0]).toMatchObject({ emulateTerminal: false });
    expect(debug.terminal).toBe(false);
    resetRuns();
    const plain = (await startRun(config({ id: "plain" })))!;
    expect(plain.terminal).toBe(false);
    expect(runtime(plain.id)!.terminal).toBeNull();
  });

  it("applies the type's launch preparation", async () => {
    const dispose = registerRunConfigType({
      id: "prepared",
      label: "Prepared",
      icon: "run",
      fields: [],
      commandLine: () => ({ command: "x", args: [] }),
      prepareLaunch: async (c) => ({ ...c, env: { ...c.env, DOCKER_HOST: "tcp://box:2375" } }),
    });
    await startRun(config({ kind: "prepared" }));
    expect(ipc.runStart.mock.calls[0]![0]).toMatchObject({ env: { DOCKER_HOST: "tcp://box:2375" } });
    dispose();
  });

  it("applies to process types only, not tests or compounds", () => {
    expect(terminalApplies(config())).toBe(true);
    expect(terminalApplies(config({ isTest: true }))).toBe(false);
    expect(terminalApplies(config({ kind: "compound" }))).toBe(false);
    expect(optionPatch("isTest", true)).toEqual({ isTest: true, emulateTerminal: false });
  });

  it("keeps the type's stop command with the command line", () => {
    const type = {
      id: "t",
      label: "T",
      icon: "run",
      fields: [],
      commandLine: (p: Readonly<Record<string, string>>) => ({ command: "run", args: [], stop: p.stop || null }),
    };
    const stopped = withParams(config(), { stop: "docker stop app" }, type);
    expect(stopped.stopCommand).toBe("docker stop app");
    expect("stopCommand" in withParams(stopped, {}, type)).toBe(false);
  });

  it("replays the output into a terminal console and forwards its input", async () => {
    const written: string[] = [];
    let opts: EmbeddedTerminalOptions | null = null;
    provideEmbeddedTerminal(async (_host, o) => {
      opts = o;
      return { write: (d) => written.push(d), clear: vi.fn(), focus: vi.fn(), fit: vi.fn(), dispose: vi.fn() };
    });
    const output = new TerminalOutput();
    output.append({ kind: "system", text: "top\n" });
    const onData = vi.fn();
    render(<TerminalConsole output={output} cwd="/p" onData={onData} onResize={vi.fn()} aria-label="app terminal" />);
    await vi.waitFor(() => expect(written).toEqual(["\x1b[2mtop\r\n\x1b[0m"]));
    output.append({ kind: "stdout", text: "x" });
    expect(written.at(-1)).toBe("x");
    opts!.onData("\r");
    expect(onData).toHaveBeenCalledWith("\r");
    expect(useRun.getState().sessions).toEqual([]);
  });

  it("dims IDE messages and colours errors", () => {
    expect(terminalText({ kind: "stderr", text: "bad\n" })).toBe("\x1b[31mbad\r\n\x1b[0m");
    expect(terminalText({ kind: "stdout", text: "raw\r\n" })).toBe("raw\r\n");
  });

  it("supports Emulate terminal in output console on detected plugin configurations", async () => {
    const pluginCfg = config({
      id: "plugin:go-task:dev",
      name: "dev",
      kind: "plugin",
      command: "task",
      args: ["dev"],
      detected: true,
      emulateTerminal: true,
    });
    expect(terminalApplies(pluginCfg)).toBe(true);
    expect(terminalApplies({ ...pluginCfg, isTest: true })).toBe(false);

    const session = (await startRun(pluginCfg))!;
    expect(session.terminal).toBe(true);
    expect(ipc.runStart.mock.calls[0]![0]).toMatchObject({ id: "plugin:go-task:dev", emulateTerminal: true });
  });
});
