import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  reload: vi.fn(),
  refresh: vi.fn(),
  failure: vi.fn(),
  open: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  commands: { vcsAddToIgnore: mocks.write },
  call: async (result: Promise<unknown>) => result,
}));
vi.mock("@/features/project-tree/store", () => ({ reloadAll: mocks.reload }));
vi.mock("@/workbench/contributions", () => ({
  editorService: () => ({ openFile: mocks.open }),
  notifications: () => ({ notify: mocks.notify }),
}));
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
  it("opens the .gitignore the rules were written to, which may be a nested one", async () => {
    mocks.write.mockResolvedValue(["/p/pkg/.gitignore"]);
    await addToIgnore(["/p/pkg/a.txt"], "gitignore");
    expect(mocks.open).toHaveBeenCalledWith("/p/pkg/.gitignore", { focus: true });
  });
  it("opens nothing for the local exclude file", async () => {
    mocks.write.mockResolvedValue(["/p/.git/info/exclude"]);
    await addToIgnore(["/p/a.txt"], "localExclude");
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("reports an already ignored selection instead of opening an unchanged file", async () => {
    mocks.write.mockResolvedValue([]);
    await addToIgnore(["/p/_exp"], "gitignore");
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Already ignored" }));
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("stays quiet after a failure", async () => {
    mocks.write.mockRejectedValue(new Error("Refusing symlink path"));
    await addToIgnore(["/p/_exp"], "gitignore");
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
