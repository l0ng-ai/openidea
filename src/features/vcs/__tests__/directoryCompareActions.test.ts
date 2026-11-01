import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  show: vi.fn(),
  read: vi.fn(),
  notify: vi.fn(),
  pick: vi.fn(),
  remote: vi.fn(),
  prompt: vi.fn(),
  openDiff: vi.fn(),
}));
vi.mock("../DirectoryCompare", () => ({ showDirectoryComparison: mocks.show }));
vi.mock("../dialogs", () => ({ promptText: mocks.prompt }));
vi.mock("../diffInput", () => ({ openDiff: mocks.openDiff }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.pick }));
vi.mock("@/platform/remote", () => ({ isRemoteWindow: mocks.remote }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: { fsEntryKind: mocks.read },
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify }),
}));
import { getAction, isActionEnabled } from "@/platform/actions";
import { provideProjectViewSelection } from "@/workbench/contributions";
import { registerCompareActions } from "../compare";

let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  dispose = registerCompareActions();
  mocks.remote.mockReturnValue(false);
  mocks.read.mockImplementation((path: string) =>
    Promise.resolve({ status: "ok", data: path.endsWith(".txt") ? "file" : "dir" }),
  );
});
afterEach(() => dispose());

describe("directory compare actions", () => {
  it("has a stable searchable action and resolves the selection for Find Action", async () => {
    const unselect = provideProjectViewSelection(() => ["/p/left", "/p/right"]);
    try {
      const action = getAction("diff.compareDirectories")!;
      expect(action.title).toBe("Compare Directories");
      expect(action.hidden).not.toBe(true);
      expect(isActionEnabled(action, { projectOpen: true })).toBe(true);
      await action.run({ ctx: { projectOpen: true } });
      expect(mocks.show).toHaveBeenCalledWith("/p/left", "/p/right");
      await action.run({ ctx: { projectOpen: true }, arg: { paths: ["/x/left", "/x/right"] } });
      expect(mocks.show).toHaveBeenLastCalledWith("/x/left", "/x/right");
    } finally {
      unselect();
    }
  });

  it("rejects mixed selections and does not start a directory comparison", async () => {
    await getAction("diff.compareDirectories")!.run({ ctx: {}, arg: ["/p/left", "/p/file.txt"] });
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Select two directories to compare" }));
  });

  it("uses the native folder picker for Compare With on a local directory", async () => {
    mocks.pick.mockResolvedValue("/p/right");
    await getAction("diff.compareWith")!.run({ ctx: {}, arg: { path: "/p/left", directory: true } });
    expect(mocks.pick).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(mocks.show).toHaveBeenCalledWith("/p/left", "/p/right");
    expect(mocks.openDiff).not.toHaveBeenCalled();
  });

  it("uses remote paths and validates the selected directory via the routed filesystem", async () => {
    mocks.remote.mockReturnValue(true);
    mocks.prompt.mockResolvedValue({ value: "/remote/right" });
    const unselect = provideProjectViewSelection(() => ["/remote/left"]);
    try {
      await getAction("diff.compareWith")!.run({ ctx: {} });
      expect(mocks.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ label: "Directory path", initial: "/remote/left" }),
      );
      expect(mocks.pick).not.toHaveBeenCalled();
      expect(mocks.read).toHaveBeenCalledWith("/remote/right");
      expect(mocks.show).toHaveBeenCalledWith("/remote/left", "/remote/right");
    } finally {
      unselect();
    }
  });

  it("leaves file Compare With on the existing diff flow", async () => {
    mocks.pick.mockResolvedValue("/p/b.txt");
    await getAction("diff.compareWith")!.run({ ctx: {}, arg: "/p/a.txt" });
    expect(mocks.pick).toHaveBeenCalledWith(expect.objectContaining({ directory: false }));
    expect(mocks.openDiff).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/b.txt" }));
    expect(mocks.show).not.toHaveBeenCalled();
  });
});
