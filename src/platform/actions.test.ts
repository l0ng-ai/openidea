import { expect, it, vi } from "vitest";
import { executeAction, executeActionOrThrow, registerAction } from "./actions";

it("propagates host launch errors while retaining ordinary action error handling", async () => {
  const dispose = registerAction({
    id: "test.hostLaunch",
    title: "Test",
    run: async () => {
      throw new Error("spawn failed");
    },
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(executeActionOrThrow("test.hostLaunch")).rejects.toThrow("spawn failed");
    await expect(executeAction("test.hostLaunch")).resolves.toBe(true);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    dispose();
    log.mockRestore();
  }
});
