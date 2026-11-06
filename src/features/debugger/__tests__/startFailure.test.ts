import { describe, expect, it, vi } from "vitest";
import { IpcError, type LaunchConfig } from "@/platform/ipc";
import { provideNotificationService } from "@/workbench/contributions";
import { startFailureMessage } from "../startFailure";
import { startSession, useDebug } from "../state";

const ipc = vi.hoisted(() => ({ debugStart: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const PORT_IN_USE =
  "Port 9003 is already in use: another IDE or debug session may be listening on it. Stop it or choose another port.";

describe("debug start failures", () => {
  it.each([
    "launch failed: listen EADDRINUSE: address already in use :::9003",
    "launch failed: listen EADDRINUSE: address already in use 127.0.0.1:9003",
  ])("names the port another listener holds: %s", (message) => {
    expect(startFailureMessage(new IpcError({ kind: "invalidInput", message }))).toBe(PORT_IN_USE);
  });

  it("keeps other failures as they are", () => {
    expect(startFailureMessage(new Error("launch failed: Attach requests are not supported"))).toBe(
      "launch failed: Attach requests are not supported",
    );
    expect(startFailureMessage("debug adapter exited")).toBe("debug adapter exited");
  });

  it("are what the notification of a failed start says", async () => {
    const notify = vi.fn();
    provideNotificationService({ notify });
    useDebug.setState({ sessions: {}, active: null, console: {} });
    const message = "launch failed: listen EADDRINUSE: address already in use :::9003";
    ipc.debugStart.mockResolvedValueOnce({ status: "error", error: { kind: "invalidInput", message, data: null } });
    const listen: LaunchConfig = {
      name: "Listen for Xdebug",
      adapter: "php-debug",
      request: "launch",
      program: null,
      args: [],
      cwd: "/p",
      env: {},
      extraJson: JSON.stringify({ port: 9003 }),
    };
    expect(await startSession(listen)).toBeNull();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Cannot start debugger for Listen for Xdebug", body: PORT_IN_USE }),
    );
  });
});
