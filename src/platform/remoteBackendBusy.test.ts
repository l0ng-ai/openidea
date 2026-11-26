import { afterEach, expect, it, vi } from "vitest";
import { commands, type RemoteTarget } from "./ipc";
import { connectRemote, provideBackendBusyPrompt } from "./remote";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: unknown = null;
  },
}));
vi.mock("./ipc", async (original) => ({
  ...(await original<typeof import("./ipc")>()),
  isTauri: () => true,
}));

const target: RemoteTarget = { kind: "ssh", config: "box" };
const busy = {
  status: "error" as const,
  error: { kind: "unavailable" as const, message: "busy", data: { type: "remoteBackendBusy" as const } },
};
const stop = { status: "error" as const, error: { kind: "unavailable" as const, message: "second attempt" } };

afterEach(() => vi.restoreAllMocks());

it("stops another build's backend once the user agrees, then connects again (#6119)", async () => {
  const connect = vi.spyOn(commands, "remoteConnect").mockResolvedValueOnce(busy).mockResolvedValueOnce(stop);
  const prompt = vi.fn(async () => true);
  const dispose = provideBackendBusyPrompt(prompt);
  await expect(connectRemote(target, "/srv/app")).rejects.toThrow("second attempt");
  dispose();
  expect(prompt).toHaveBeenCalledOnce();
  expect(connect.mock.calls.map((c) => c[2])).toEqual([false, true]);
});

it("keeps the error when the user declines", async () => {
  const connect = vi.spyOn(commands, "remoteConnect").mockResolvedValue(busy);
  const dispose = provideBackendBusyPrompt(async () => false);
  await expect(connectRemote(target, "/srv/app")).rejects.toThrow("busy");
  dispose();
  expect(connect).toHaveBeenCalledOnce();
});

it("doesn't ask about other connection errors", async () => {
  vi.spyOn(commands, "remoteConnect").mockResolvedValue(stop);
  const prompt = vi.fn(async () => true);
  const dispose = provideBackendBusyPrompt(prompt);
  await expect(connectRemote(target, "/srv/app")).rejects.toThrow("second attempt");
  dispose();
  expect(prompt).not.toHaveBeenCalled();
});
