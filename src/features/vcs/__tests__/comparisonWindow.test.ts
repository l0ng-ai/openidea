import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { editorService, provideEditorService, type EditorService } from "@/workbench/contributions";
import { activateComparisonWindow } from "../ComparisonWindow";

afterEach(clearMocks);

async function comparisonWindowOf(project: Record<string, unknown>) {
  mockWindows("comparison-main-1");
  const emitted = vi.fn();
  const asked = vi.fn();
  mockIPC((command, args) => {
    asked(command);
    if (command === "plugin:event|emit_to") emitted(args);
    if (command === "window_take_launch") return { comparison: { repo: "/repo" } };
    if (command === "project_current") return { name: "app", settings: {}, ...project };
    if (command === "vcs_roots") return [];
    return null;
  });
  const local = { openFile: vi.fn(async () => {}), openInput: vi.fn(async () => {}) };
  provideEditorService(local as unknown as EditorService);
  const stop = activateComparisonWindow("main", async () => true);
  await vi.waitFor(() => expect(asked).toHaveBeenCalledWith("vcs_roots"));
  return { emitted, local, stop };
}

const options = { selection: { line: 3, col: 1 }, focus: true };

it("hands Jump to Source to the project window's editor", async () => {
  const { emitted, local, stop } = await comparisonWindowOf({ root: "/repo/app" });
  try {
    await editorService().openFile("/repo/app/src/a.ts", options);

    expect(local.openFile).not.toHaveBeenCalled();
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "openidea://diff/open-source",
        payload: { path: "/repo/app/src/a.ts", options },
      }),
    );
    expect(editorService().openInput).toBe(local.openInput);

    // The project window drops files outside its project (a repo above it): open those here.
    await editorService().openFile("/repo/other/b.ts", options);
    expect(local.openFile).toHaveBeenCalledWith("/repo/other/b.ts", options);
    expect(emitted).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

it("hands over files of every folder of a workspace project", async () => {
  const { emitted, local, stop } = await comparisonWindowOf({
    root: "/state/workspace",
    workspace: { projects: ["/repo/app", "/repo/lib"] },
  });
  try {
    await editorService().openFile("/repo/lib/src/b.ts", options);

    expect(local.openFile).not.toHaveBeenCalled();
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ payload: { path: "/repo/lib/src/b.ts", options } }));
  } finally {
    stop();
  }
});
