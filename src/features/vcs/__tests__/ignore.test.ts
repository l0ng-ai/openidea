import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  reload: vi.fn(),
  refresh: vi.fn(),
  failure: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  commands: { vcsAddToIgnore: mocks.write },
  call: async (result: Promise<unknown>) => result,
}));
vi.mock("@/features/project-tree/store", () => ({ reloadAll: mocks.reload }));
vi.mock("../store", () => ({ refreshNow: mocks.refresh }));
vi.mock("../ops", () => ({
  runOp: async (_title: string, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch (error) {
      mocks.failure(error);
      return undefined;
    }
  },
}));
import { addToIgnore } from "../ignore";

describe("ignore action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.write.mockResolvedValue(null);
  });
  it.each(["gitignore", "localExclude"] as const)(
    "routes all paths to %s then refreshes status and tree",
    async (destination) => {
      await addToIgnore(["/p/file", "/p/directory"], destination);
      expect(mocks.write).toHaveBeenCalledWith(["/p/file", "/p/directory"], destination);
      expect(mocks.refresh).toHaveBeenCalledOnce();
      expect(mocks.reload).toHaveBeenCalledOnce();
    },
  );
  it("refreshes after a failed or partially completed multi-repository write", async () => {
    mocks.write.mockRejectedValue(new Error("locked; retry"));
    await addToIgnore(["/p/file"], "gitignore");
    expect(mocks.failure).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.reload).toHaveBeenCalledOnce();
  });
  it("ignores an empty selection", async () => {
    await addToIgnore([], "gitignore");
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
