import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { installWorkspaceEditUndo } from "./workspaceUndo";

const mocks = vi.hoisted(() => ({ undo: vi.fn(), synced: vi.fn() }));
vi.mock("@/editor/api", () => ({ whenAllSynced: mocks.synced }));
vi.mock("@/bindings", () => ({ commands: { undoWorkspaceEdit: mocks.undo } }));

let stop: () => void;
let notices: Parameters<NotificationService["notify"]>[0][];

beforeEach(() => {
  mocks.undo.mockReset().mockResolvedValue({ status: "ok", data: null });
  mocks.synced.mockReset().mockResolvedValue(undefined);
  notices = [];
  provideNotificationService({
    notify: (notice) => {
      notices.push(notice);
    },
  });
  stop = installWorkspaceEditUndo();
});

afterEach(() => stop());

it("waits for pending typing before undoing the entire backend transaction", async () => {
  let release: () => void = () => {};
  mocks.synced.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  emitLocalIdeEvent({ type: "workspaceEditApplied", id: 17 });
  const action = notices[0]!.actions![0]!;
  expect(action.label).toBe("Undo");
  const pending = action.run();
  expect(mocks.undo).not.toHaveBeenCalled();
  release();
  await pending;
  expect(mocks.undo).toHaveBeenCalledExactlyOnceWith(17);
});

it("reports a refused undo instead of discarding newer work", async () => {
  mocks.undo.mockResolvedValue({ status: "error", error: { kind: "outOfSync", message: "a.txt changed" } });
  emitLocalIdeEvent({ type: "workspaceEditApplied", id: 18 });
  await notices[0]!.actions![0]!.run();
  expect(notices[1]).toMatchObject({ level: "error", title: "Cannot undo refactoring", body: "a.txt changed" });
});

it("does not apply an old notification's id to a different project", async () => {
  emitLocalIdeEvent({ type: "workspaceEditApplied", id: 19 });
  const previous = useProject.getState().project;
  useProject.setState({ project: { ...previous, root: "/different-project" } as NonNullable<typeof previous> });
  try {
    await notices[0]!.actions![0]!.run();
    expect(mocks.undo).not.toHaveBeenCalled();
    expect(notices[1]).toMatchObject({ level: "error", body: "The project for this refactoring is no longer open" });
  } finally {
    useProject.setState({ project: previous });
  }
});
