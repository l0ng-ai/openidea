import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { editorService, provideEditorService, type EditorService } from "@/workbench/contributions";
import { activateComparisonWindow } from "../ComparisonWindow";
import { useVcs } from "../store";

afterEach(clearMocks);

it("hands Jump to Source to the project window's editor", async () => {
  mockWindows("comparison-main-1");
  const emitted = vi.fn();
  mockIPC((command, args) => {
    if (command === "plugin:event|emit_to") emitted(args);
    return null;
  });
  const local = { openFile: vi.fn(async () => {}), openInput: vi.fn(async () => {}) };
  provideEditorService(local as unknown as EditorService);
  const stop = activateComparisonWindow("main", async () => true);
  useVcs.setState({ root: "/repo/app" });
  try {
    const options = { selection: { line: 3, col: 1 }, focus: true };
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
