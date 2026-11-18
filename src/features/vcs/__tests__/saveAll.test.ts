import { beforeEach, expect, it, vi } from "vitest";

const saves = vi.hoisted(() => ({ peers: vi.fn(), local: vi.fn(), notify: vi.fn() }));
vi.mock("../diffWindowSave", () => ({ saveDiffWindows: saves.peers }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ saveAll: saves.local }),
  notifications: () => ({ notify: saves.notify }),
}));

import { saveAll } from "../ops";

beforeEach(() => {
  saves.peers.mockReset().mockResolvedValue(undefined);
  saves.local.mockReset().mockResolvedValue(undefined);
  saves.notify.mockReset();
});

it("waits for peer saves once, then saves the local editor without another broadcast", async () => {
  let finish!: () => void;
  saves.peers.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  const saving = saveAll();
  expect(saves.local).not.toHaveBeenCalled();
  finish();
  await saving;
  expect(saves.peers).toHaveBeenCalledOnce();
  expect(saves.local).toHaveBeenCalledOnce();
  expect(saves.local).toHaveBeenCalledWith({ includeOtherWindows: false });
});

it("stops the Git operation when a peer cannot save", async () => {
  saves.peers.mockRejectedValue(new Error("Disk full"));
  await expect(saveAll()).rejects.toThrow("Disk full");
  expect(saves.local).not.toHaveBeenCalled();
  expect(saves.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "Disk full" }));
});

it("keeps local saves best effort after the peers have saved", async () => {
  saves.local.mockRejectedValue(new Error("Read only"));
  await expect(saveAll()).resolves.toBeUndefined();
  expect(saves.peers).toHaveBeenCalledOnce();
});
