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
    const tabClose = vi.fn();
    const dispose = registerEditorKind({
      kind: "close-probe",
      title: () => "Probe",
      component: () => null,
      onClose: close,
      onTabClose: tabClose,
    });
    controller = new EditorController(createMemoryBackend({}));
    controller.start();
    const input = { kind: "close-probe", key: "close-probe:1" };
    try {
      await controller.openInput(input);
      controller.split(useTabs.getState().activePane, "row");
      const panes = Object.values(useTabs.getState().panes);
      expect(panes).toHaveLength(2);
      const firstTabId = panes[0]!.tabs[0]!.id;
      const secondTabId = panes[1]!.tabs[0]!.id;
      await controller.closeTab(panes[0]!.id, firstTabId);
      expect(tabClose).toHaveBeenCalledExactlyOnceWith(firstTabId, input);
      expect(close).not.toHaveBeenCalled();
      await controller.closeInput(input.key);
      expect(tabClose).toHaveBeenCalledTimes(2);
      expect(tabClose).toHaveBeenLastCalledWith(secondTabId, input);
      expect(close).toHaveBeenCalledExactlyOnceWith(input);
    } finally {
      dispose();
    }
  });
});
