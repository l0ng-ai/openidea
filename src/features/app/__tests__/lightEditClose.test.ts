import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { provideEditorService, type EditorInput, type OpenEditorTab } from "@/workbench/contributions";
import { installLightEditAutoClose } from "../windows";

/** An editor service whose tabs the test drives. */
function fakeEditor() {
  const listeners = new Set<(input: EditorInput | null) => void>();
  let tabs: string[] = [];
  provideEditorService({
    openFile: async () => {},
    openInput: async () => {},
    activePath: () => tabs.at(-1) ?? null,
    activeCursor: () => null,
    saveAll: async () => {},
    openTabs: () => tabs.map((path) => ({ input: { kind: "file", key: path, path } }) as OpenEditorTab),
    onActiveInputChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  return {
    setTabs(next: string[]) {
      tabs = next;
      const path = next.at(-1);
      for (const fn of listeners) fn(path ? ({ kind: "file", key: path, path } as EditorInput) : null);
    },
  };
}

describe("LightEdit window", () => {
  const close = vi.fn(async () => {});
  let dispose: () => void = () => {};
  beforeEach(() => close.mockClear());
  afterEach(() => {
    dispose();
    useProject.setState({ project: null, lightEdit: false });
  });

  it("closes when its last editor tab closes", () => {
    const editor = fakeEditor();
    useProject.setState({ project: null, lightEdit: true });
    dispose = installLightEditAutoClose(close);
    editor.setTabs(["/x/a.txt", "/x/b.txt"]);
    editor.setTabs(["/x/a.txt"]);
    expect(close).not.toHaveBeenCalled();
    editor.setTabs([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stays open in a project window or while leaving LightEdit", () => {
    const editor = fakeEditor();
    dispose = installLightEditAutoClose(close);
    useProject.setState({ project: { root: "/p", name: "p" }, lightEdit: false } as never);
    editor.setTabs(["/p/a.rs"]);
    editor.setTabs([]);
    // Closing the project (or the LightEdit session) closes every tab after `lightEdit` is off.
    useProject.setState({ project: null, lightEdit: false });
    editor.setTabs([]);
    expect(close).not.toHaveBeenCalled();
  });
});
