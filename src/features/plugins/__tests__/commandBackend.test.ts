import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { tauriPluginsBackend } from "../backend";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<object>()),
  invoke: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

it("cancels the same IPC request and settles the caller as soon as it aborts", async () => {
  let complete!: (value: string) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_run_command"
      ? new Promise<string>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(null),
  );
  const controller = new AbortController();
  const pending = tauriPluginsBackend.runCommand(
    "example",
    "annotations",
    "buffer",
    null,
    [],
    undefined,
    undefined,
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  // A late answer is not delivered to a caller that already gave up.
  complete("finished");
  const args = vi.mocked(invoke).mock.calls.find(([command]) => command === "plugin_run_command")?.[1];
  const request = args && "request" in args ? args.request : undefined;
  expect(request).toEqual(expect.any(Number));
  expect(invoke).toHaveBeenCalledWith("cancel_request", { id: request });
});

it("settles an aborted command even when the backend never answers", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_run_command" ? new Promise<string>(() => {}) : Promise.resolve(null),
  );
  const controller = new AbortController();
  const pending = tauriPluginsBackend.runCommand(
    "example",
    "annotations",
    "buffer",
    null,
    [],
    undefined,
    undefined,
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledWith("cancel_request", { id: expect.any(Number) });
});

it("does not invoke a command when the caller signal is already aborted", async () => {
  vi.mocked(invoke).mockResolvedValue("finished");
  const controller = new AbortController();
  controller.abort();

  await expect(
    tauriPluginsBackend.runCommand("example", "annotations", "buffer", null, [], undefined, undefined, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).not.toHaveBeenCalled();
});

it("does not cancel a completed command when the caller later aborts", async () => {
  vi.mocked(invoke).mockResolvedValue("finished");
  const controller = new AbortController();

  await expect(
    tauriPluginsBackend.runCommand("example", "annotations", "buffer", null, [], undefined, undefined, controller.signal),
  ).resolves.toBe("finished");
  controller.abort();

  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_run_command", {
    pluginId: "example",
    commandId: "annotations",
    arg: "buffer",
    editor: null,
    paths: [],
    settingsScope: null,
    commandChain: null,
    request: expect.any(Number),
  });
});

it("passes a null request for ordinary command callers without a signal", async () => {
  vi.mocked(invoke).mockResolvedValue("finished");

  await expect(tauriPluginsBackend.runCommand("example", "annotations", "buffer", null, [])).resolves.toBe("finished");

  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_run_command", {
    pluginId: "example",
    commandId: "annotations",
    arg: "buffer",
    editor: null,
    paths: [],
    settingsScope: null,
    commandChain: null,
    request: null,
  });
});
