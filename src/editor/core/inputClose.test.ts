import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEditorKind } from "@/workbench/contributions";
import { EditorController, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
let controller: EditorController | null = null;
afterEach(() => {
  controller?.stop();
  controller = null;
  useTabs.setState(initialTabsState(), true);
});
describe("custom editor close lifecycle", () => {
  it("notifies once when the last split showing an input closes", async () => {
    const close = vi.fn();
    const dispose = registerEditorKind({
      kind: "close-probe",
      title: () => "Probe",
      component: () => null,
      onClose: close,
    });
    controller = new EditorController(createMemoryBackend({}));
    controller.start();
    const input = { kind: "close-probe", key: "close-probe:1" };
    try {
      await controller.openInput(input);
      controller.split(useTabs.getState().activePane, "row");
      const panes = Object.values(useTabs.getState().panes);
      expect(panes).toHaveLength(2);
      await controller.closeTab(panes[0]!.id, panes[0]!.tabs[0]!.id);
      expect(close).not.toHaveBeenCalled();
      await controller.closeInput(input.key);
      expect(close).toHaveBeenCalledExactlyOnceWith(input);
    } finally {
      dispose();
    }
  });
});
