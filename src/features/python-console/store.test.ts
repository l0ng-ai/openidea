import { beforeEach, expect, it, vi } from "vitest";
import type { OutputChunk } from "@/platform/ipc";

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const ipc = vi.hoisted(() => ({
  exited: (_e: { run: number; code: number | null }) => {},
  started: null as null | { resolve: (id: number) => void; channel: { onmessage?: (c: OutputChunk) => void } },
  stdin: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/platform/auxWindow", () => ({ windowLabel: () => "main" }));
vi.mock("@/workbench/contributions", () => ({ editorService: () => ({ activePath: () => null }) }));
vi.mock("@/platform/project", () => ({
  dirname: (p: string) => p,
  useProject: { getState: () => ({ project: { root: "/p" } }), subscribe: () => () => {} },
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    onIdeEvent: (_type: string, handler: typeof ipc.exited) => {
      ipc.exited = handler;
      return () => {};
    },
    commands: {
      runList: () => Promise.resolve([]),
      sdkPythonEffective: () => ok("/venv/bin/python"),
      runStart: (_config: unknown, channel: NonNullable<typeof ipc.started>["channel"]) =>
        new Promise((resolve) => {
          ipc.started = { channel, resolve: (id) => resolve({ status: "ok", data: { id } }) };
        }),
      runStdin: (id: number, data: string) => {
        ipc.stdin(id, data);
        return ok(null);
      },
      runStop: () => ok(null),
    },
  };
});

const { execute, installConsole, stopConsole, tail, useConsole } = await import("./store");
const { request } = await import("./protocol");
const settle = () => new Promise((r) => setTimeout(r, 0));
const text = () =>
  useConsole
    .getState()
    .output.map((s) => s.text)
    .join("");

installConsole();
beforeEach(() => {
  stopConsole();
  ipc.started = null;
  ipc.stdin.mockClear();
});

it("runs code sent while starting once the driver is ready, even before the start call returns", async () => {
  execute("x = 1");
  await settle();
  ipc.started!.channel.onmessage!({ kind: "stdout", text: '\x1e{"ready":{"version":"3.12.1","ipython":null}}\n' });
  expect(ipc.stdin).not.toHaveBeenCalled();
  ipc.started!.resolve(7);
  await settle();
  expect(ipc.stdin).toHaveBeenCalledWith(7, request("x = 1"));
  expect(useConsole.getState().status).toBe("busy");
});

it("reports an interpreter that exits before the start call returns", async () => {
  execute("x = 1");
  await settle();
  ipc.exited({ run: 8, code: 1 });
  ipc.started!.resolve(8);
  await settle();
  expect(useConsole.getState().status).toBe("stopped");
  expect(text()).toContain("exit code 1");
  expect(ipc.stdin).not.toHaveBeenCalled();
});

it("keeps the newest output within the cap, cutting into the oldest kept span", () => {
  const spans = [{ text: "aaaa" }, { text: "bb", fg: "red" }, { text: "cc" }];
  expect(tail(spans, 10)).toBe(spans);
  expect(tail(spans, 5)).toEqual([{ text: "a" }, { text: "bb", fg: "red" }, { text: "cc" }]);
  expect(tail(spans, 3)).toEqual([{ text: "b", fg: "red" }, { text: "cc" }]);
});
