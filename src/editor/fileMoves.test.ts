import { afterEach, expect, it } from "vitest";
import { onIdeEvent } from "@/platform/ipc";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import { createMemoryBackend } from "./core/backend";
import { EditorController, useTabs } from "./core/controller";
import { initialTabsState } from "./core/model/tabs";
import { editorsFollowAppliedMoves } from "./fileMoves";

let ctrl: EditorController | null = null;

afterEach(() => {
  ctrl?.stop();
  ctrl = null;
  useTabs.setState(initialTabsState(), true);
});

function setup(files: Record<string, string>) {
  const backend = createMemoryBackend(files);
  backend.onFsChanged = (h) => onIdeEvent("fsChanged", h);
  const controller = new EditorController(backend);
  controller.start();
  ctrl = controller;
  provideEditorService({
    openFile: (path, o) => controller.openFile(path, o),
    activePath: () => controller.activePath(),
    closePath: (path) => controller.closePath(path),
    saveAll: async () => {},
  } as Partial<EditorService> as EditorService);
  return { controller, backend };
}

const tabPaths = () =>
  Object.values(useTabs.getState().panes).flatMap((pane) => pane.tabs.map((tab) => tab.input.path));

it("a renamed active file stays the active editor", async () => {
  const { controller, backend } = setup({ "/p/A.java": "class A {}", "/p/B.java": "class B {}" });
  await controller.openFile("/p/B.java", { focus: false });
  await controller.openFile("/p/A.java", { focus: false });
  backend.files.set("/p/Renamed.java", backend.files.get("/p/A.java")!);
  backend.files.delete("/p/A.java");

  await editorsFollowAppliedMoves([{ from: "/p/A.java", to: "/p/Renamed.java" }]);

  expect(tabPaths()).toEqual(["/p/B.java", "/p/Renamed.java"]);
  expect(controller.activePath()).toBe("/p/Renamed.java");
});

it("a renamed background file leaves the active editor in place", async () => {
  const { controller, backend } = setup({ "/p/A.java": "class A {}", "/p/B.java": "class B {}" });
  await controller.openFile("/p/A.java", { focus: false });
  await controller.openFile("/p/B.java", { focus: false });
  backend.files.set("/p/Renamed.java", backend.files.get("/p/A.java")!);
  backend.files.delete("/p/A.java");

  await editorsFollowAppliedMoves([{ from: "/p/A.java", to: "/p/Renamed.java" }]);

  expect(tabPaths().sort()).toEqual(["/p/B.java", "/p/Renamed.java"]);
  expect(controller.activePath()).toBe("/p/B.java");
});
