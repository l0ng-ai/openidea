import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeAction, getAction } from "@/platform/actions";
import { setFileDecorations } from "@/workbench/contributions";
import { resolveActionId } from "@/features/vim/rc";
import { registerEditorActions } from "./actions";
import { editorController, useTabs } from "./controller";
import { useDocMeta } from "./model/document";
import { initialTabsState } from "./model/tabs";

const ctrl = editorController();
let dispose: () => void;
beforeAll(() => {
  dispose = registerEditorActions();
  ctrl.start();
});
afterAll(() => {
  ctrl.stop();
  dispose();
});

const pane = () => useTabs.getState().panes[useTabs.getState().activePane]!;
const names = () => pane().tabs.map((t) => t.input.path?.slice("/tabs/".length));
const tabOf = (name: string) => pane().tabs.find((t) => t.input.path === `/tabs/${name}`)!;
const activate = (name: string) => ctrl.activate(pane().id, tabOf(name).id, false);
const pin = (name: string) => ctrl.togglePin(pane().id, tabOf(name).id);

beforeEach(async () => {
  // oxlint-disable-next-line no-await-in-loop -- the tab order is what these tests assert
  for (const name of ["a", "b", "c", "d", "e"]) await ctrl.openFile(`/tabs/${name}`, { focus: false });
});
afterEach(async () => {
  await ctrl.closeEverything();
  useTabs.setState(initialTabsState(), true);
  setFileDecorations("vcs", new Map());
  useDocMeta.setState({}, true);
});

describe("Window › Editor Tabs close actions", () => {
  it.each([
    ["editor.closeTabsToLeft", "Close Tabs to the Left", "CloseAllToTheLeft"],
    ["editor.closeTabsToRight", "Close Tabs to the Right", "CloseAllToTheRight"],
    ["editor.closeUnmodifiedTabs", "Close Unmodified Tabs", "CloseAllUnmodifiedEditors"],
    ["editor.closeAllButPinned", "Close All but Pinned", "CloseAllUnpinnedEditors"],
    ["editor.closeReadOnlyTabs", "Close All Read-Only Tabs", "CloseAllReadonly"],
  ])("%s is %s in Window, mapped from IDEA's %s", (id, title, ideaId) => {
    expect(getAction(id)).toMatchObject({ title, category: "Window" });
    expect(resolveActionId(ideaId)).toBe(id);
  });

  it("closes the tabs left of the active one, keeping pinned tabs", async () => {
    pin("a");
    activate("c");
    expect(await executeAction("editor.closeTabsToLeft")).toBe(true);
    expect(names()).toEqual(["a", "c", "d", "e"]);
    expect(pane().active).toBe(tabOf("c").id);
  });

  it("closes the tabs right of the active one, keeping pinned tabs", async () => {
    activate("b");
    pin("e");
    // Pinned tabs move to the front: e, a, b, c, d.
    expect(await executeAction("editor.closeTabsToRight")).toBe(true);
    expect(names()).toEqual(["e", "a", "b"]);
  });

  it("is unavailable at the edges, as the tab menu items are disabled", async () => {
    activate("a");
    expect(await executeAction("editor.closeTabsToLeft")).toBe(false);
    activate("e");
    expect(await executeAction("editor.closeTabsToRight")).toBe(false);
    expect(names()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("closes unmodified tabs, keeping VCS-changed and pinned ones", async () => {
    setFileDecorations("vcs", new Map([["/tabs/b", { color: "modified" }]]));
    pin("d");
    expect(await executeAction("editor.closeUnmodifiedTabs")).toBe(true);
    expect(names()).toEqual(["d", "b"]);
  });

  it("closes every tab but the pinned ones", async () => {
    pin("c");
    expect(await executeAction("editor.closeAllButPinned")).toBe(true);
    expect(names()).toEqual(["c"]);
  });

  it("is unavailable without a pinned tab instead of closing everything", async () => {
    expect(await executeAction("editor.closeAllButPinned")).toBe(false);
    expect(names()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("is unavailable without an unpinned read-only tab", async () => {
    expect(await executeAction("editor.closeReadOnlyTabs")).toBe(false);
    useDocMeta.setState({ "/tabs/b": { readOnly: true } } as never);
    pin("b");
    expect(await executeAction("editor.closeReadOnlyTabs")).toBe(false);
    expect(names()).toEqual(["b", "a", "c", "d", "e"]);
  });

  it("closes read-only tabs, keeping pinned ones", async () => {
    useDocMeta.setState({ "/tabs/b": { readOnly: true }, "/tabs/c": { readOnly: true } } as never);
    pin("c");
    expect(await executeAction("editor.closeReadOnlyTabs")).toBe(true);
    expect(names()).toEqual(["c", "a", "d", "e"]);
  });

  it("acts on the active split only", async () => {
    const left = pane().id;
    ctrl.split(left, "row");
    await ctrl.openFile("/tabs/x", { focus: false });
    expect(useTabs.getState().activePane).not.toBe(left);
    expect(names()).toEqual(["e", "x"]);
    await executeAction("editor.closeTabsToLeft");
    expect(names()).toEqual(["x"]);
    expect(useTabs.getState().panes[left]!.tabs).toHaveLength(5);
  });
});
