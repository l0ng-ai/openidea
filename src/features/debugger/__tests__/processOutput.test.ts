import { beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { LaunchConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideRunOutput,
  provideToolWindowService,
  type ToolWindowService,
} from "@/workbench/contributions";
import { removeSession, startSession, useDebug } from "../state";

const ipc = vi.hoisted(() => ({ debugStart: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const attach: LaunchConfig = {
  name: "demo [spring-boot:run]",
  adapter: "java-debug",
  request: "attach",
  program: null,
  args: [],
  cwd: "/p",
  env: {},
  extraJson: JSON.stringify({ hostName: "127.0.0.1", port: 5005 }),
};

type Listener = (kind: "stdout" | "stderr" | "system", text: string) => void;
const listeners = new Map<number, Listener>();
const text = (session: number) => (useDebug.getState().console[session] ?? []).map((l) => l.text).join("");

beforeEach(() => {
  useDebug.setState({ sessions: {}, active: null, console: {} });
  useProject.setState({ project: { root: "/p" } as never });
  provideNotificationService({ notify: vi.fn() });
  provideToolWindowService({ show: vi.fn() } as unknown as ToolWindowService);
  listeners.clear();
  provideRunOutput({
    subscribe: (process, listener) => {
      // The output so far comes first.
      listener("system", "mvn spring-boot:run\n");
      listener("stdout", "[INFO] Building demo\n");
      listeners.set(process, listener);
      return () => void listeners.delete(process);
    },
  });
  ipc.debugStart.mockResolvedValue({ status: "ok", data: 21 });
});

it("shows the output of the Run process a debugger attached to in its Console", async () => {
  expect(await startSession(attach, { process: 7, rerunnable: false })).toBe(21);
  listeners.get(7)!("stdout", "Tomcat started on port 8080 (http)\n");
  listeners.get(7)!("stderr", "WARN something\n");
  await vi.waitFor(() => expect(text(21)).toContain("WARN something"));
  expect(text(21)).toBe(
    "mvn spring-boot:run\n[INFO] Building demo\nTomcat started on port 8080 (http)\nWARN something\n",
  );
  const categories = (useDebug.getState().console[21] ?? []).map((l) => l.category);
  expect(categories).toEqual(["system", "stdout", "stdout", "stderr"]);
});

it("stops following the process once the session is closed", async () => {
  await startSession(attach, { process: 7, rerunnable: false });
  expect(listeners.has(7)).toBe(true);
  removeSession(21);
  expect(listeners.has(7)).toBe(false);
});

it("follows nothing for a session the debugger launched itself", async () => {
  await startSession({ ...attach, request: "launch" });
  expect(listeners.size).toBe(0);
});
