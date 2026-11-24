import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { activateDiffWindow, showDiffWindow } from "../DiffWindow";
import { chainNeighbour, openDiff, withChain, workingDiffData } from "../diffInput";
import { setAllInOneDiff } from "../allInOneDiff";

const ask = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof import("@/workbench/messages")>()),
  ask,
}));
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  refreshNow: async () => {},
}));
vi.mock("@/editor/core/embeddedDocuments", () => ({
  activateEmbeddedDocuments: () => ({ dirty: () => true }),
}));

afterEach(clearMocks);

it("passes the ordered working-tree diff chain to the separate window", () => {
  const launch = vi.fn();
  mockIPC((command, args) => {
    if (command === "window_open_diff") launch(args);
    return { status: "ok", data: null };
  });
  const diffs = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"].map((path) => workingDiffData(path));

  showDiffWindow(withChain(diffs, 1), vi.fn());

  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({ diff: expect.objectContaining({ path: "/repo/b.ts", chain: diffs }) }),
  );
});

it("keeps diff navigation local and resumes a later open request when closing is cancelled", async () => {
  mockWindows("diff-main-1");
  const title = vi.fn();
  const diffs = ["/repo/a.ts", "/repo/b.ts"].map((path) => workingDiffData(path));
  const first = withChain(diffs, 0);
  let launch: typeof first | undefined = first;
  mockIPC(
    (command, args) => {
      switch (command) {
        case "window_take_launch": {
          const pending = launch;
          launch = undefined;
          return pending ? { diffWindow: pending } : null;
        }
        case "project_current":
          return { name: "repo", root: "/repo", settings: { files: { autoSave: false } } };
        case "vcs_roots":
          return [{ root: "/repo" }];
        case "plugin:window|set_title":
          title(args);
          break;
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  setAllInOneDiff(true);
  let cancelClose!: (result: { button: string }) => void;
  ask.mockReturnValue(new Promise<{ button: string }>((resolve) => (cancelClose = resolve)));
  const stop = activateDiffWindow("main");
  try {
    await vi.waitFor(() =>
      expect(title).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.stringContaining("a.ts") })),
    );
    await openDiff(chainNeighbour(first, 1)!);
    expect(title).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.stringContaining("b.ts") }));

    await emit("tauri://close-requested");
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    launch = first;
    await emit("openidea://launch");
    expect(title).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.stringContaining("b.ts") }));
    cancelClose({ button: "cancel" });
    await vi.waitFor(() =>
      expect(title).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.stringContaining("a.ts") })),
    );
  } finally {
    cancelClose({ button: "cancel" });
    stop();
    setAllInOneDiff(false);
  }
});
