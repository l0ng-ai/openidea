import { afterEach, expect, it, vi } from "vitest";
import { useRemote } from "./remote";
import { scratchesDir } from "./scratchesDir";

// Routed like every file command: the server answers in a remote window.
const fsScratchesDir = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...m, call: async (p: Promise<unknown>) => await p, commands: { ...m.commands, fsScratchesDir } };
});

afterEach(() => useRemote.setState({ session: null }));

it("asks the host again once the window attaches to or leaves a remote server", async () => {
  fsScratchesDir.mockResolvedValue("C:/Users/me/AppData/Roaming/ai.l0ng.openidea/scratches/");
  const pending = scratchesDir();
  expect(scratchesDir()).toBe(pending);
  expect(await pending).toBe("C:/Users/me/AppData/Roaming/ai.l0ng.openidea/scratches");
  expect(await scratchesDir()).toBe("C:/Users/me/AppData/Roaming/ai.l0ng.openidea/scratches");
  expect(fsScratchesDir).toHaveBeenCalledTimes(2);

  fsScratchesDir.mockResolvedValue("/home/me/.openidea/data/scratches");
  useRemote.setState({ session: { root: "/home/me/project" } as never });
  expect(await scratchesDir()).toBe("/home/me/.openidea/data/scratches");

  fsScratchesDir.mockResolvedValue("C:/Users/me/AppData/Roaming/ai.l0ng.openidea/scratches");
  useRemote.setState({ session: null });
  expect(await scratchesDir()).toBe("C:/Users/me/AppData/Roaming/ai.l0ng.openidea/scratches");
  expect(fsScratchesDir).toHaveBeenCalledTimes(4);
});

it("asks again after a failure", async () => {
  useRemote.setState({ session: { root: "/p" } as never });
  fsScratchesDir.mockRejectedValueOnce(new Error("disconnected"));
  await expect(scratchesDir()).rejects.toThrow("disconnected");
  fsScratchesDir.mockResolvedValue("/home/me/.openidea/data/scratches");
  expect(await scratchesDir()).toBe("/home/me/.openidea/data/scratches");
});
