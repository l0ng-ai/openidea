import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEditorKind } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { EditorController, KEPT_KIND_EDITORS, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { storeSession } from "./model/session";

let controller: EditorController | null = null;
const settings = useProject.getState().settings;
const dispose: Array<() => void> = [];
afterEach(() => {
  controller?.stop();
  controller = null;
  dispose.splice(0).forEach((stop) => stop());
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ settings });
});

function start() {
  dispose.push(
    registerEditorKind({ kind: "managed", component: () => null, title: (input) => input.key, tabless: true }),
  );
  controller = new EditorController(createMemoryBackend({ "/a.txt": "A", "/b.txt": "B" }));
  controller.start();
  return controller;
}

describe("editors managed outside the tab strip", () => {
  it("skips managed inputs in both directions while cycling file tabs", async () => {
    const editor = start();
    await editor.openFile("/a.txt");
    await editor.openInput({ kind: "managed", key: "conversation" });
    await editor.openFile("/b.txt");
    editor.cycle(-1);
    expect(editor.activeInput()?.path).toBe("/a.txt");
    editor.cycle(1);
    expect(editor.activeInput()?.path).toBe("/b.txt");
    await editor.openInput({ kind: "managed", key: "conversation" });
    editor.cycle(1);
    expect(editor.activeInput()?.path).toBe("/a.txt");
    await editor.openInput({ kind: "managed", key: "conversation" });
    editor.cycle(-1);
    expect(editor.activeInput()?.path).toBe("/b.txt");
  });

  it("keeps the managed conversation and does not let it consume the file-tab limit", async () => {
    useProject.setState({ settings: { editor: { tabs: { tabLimit: 1, closingPolicy: "lru" } } } as never });
    const editor = start();
    await editor.openFile("/a.txt");
    await editor.openInput({ kind: "managed", key: "conversation" });
    expect(editor.openTabs().map((tab) => tab.input.key)).toHaveLength(2);
    expect(editor.openPaths()).toEqual(["/a.txt"]);
    await editor.openFile("/b.txt");
    expect(editor.openPaths()).toEqual(["/b.txt"]);
    expect(editor.openTabs().some((tab) => tab.input.key === "conversation")).toBe(true);
  });

  it("retains normal close lifecycle for managed inputs", async () => {
    const close = vi.fn();
    const editor = start();
    dispose.push(
      registerEditorKind({
        kind: "closable-managed",
        component: () => null,
        title: (input) => input.key,
        tabless: true,
        onClose: close,
      }),
    );
    const input = { kind: "closable-managed", key: "conversation" };
    await editor.openInput(input);
    await editor.closeInput(input.key);
    expect(close).toHaveBeenCalledExactlyOnceWith(input);
    expect(editor.openTabs()).toEqual([]);
  });

  it.each(["closeOthers", "closeAll", "closeToLeft", "closeToRight", "closeUnmodified"] as const)(
    "keeps managed conversations out of %s file-tab operations",
    async (operation) => {
      const editor = start();
      await editor.openFile("/a.txt");
      await editor.openInput({ kind: "managed", key: "conversation" });
      await editor.openFile("/b.txt");
      const state = useTabs.getState();
      const pane = state.panes[state.activePane]!;
      const file = pane.tabs.find((tab) => tab.input.path === (operation === "closeToLeft" ? "/b.txt" : "/a.txt"))!;
      if (operation === "closeAll" || operation === "closeUnmodified") await editor[operation](pane.id);
      else await editor[operation](pane.id, file.id);
      expect(editor.openTabs().some((tab) => tab.input.key === "conversation")).toBe(true);
    },
  );

  it("restores a legacy pinned conversation as a managed view", async () => {
    const root = "/managed-session-restore";
    const editor = start();
    storeSession(root, {
      version: 1,
      layout: {
        kind: "pane",
        tabs: [{ path: "/a.txt" }, { input: { kind: "managed", key: "conversation" }, pinned: true }],
        active: 1,
      },
      activePane: 0,
      files: {},
    });
    try {
      await editor.restoreSession(root);
      expect(editor.activeInput()?.key).toBe("conversation");
      const state = useTabs.getState();
      expect(state.panes[state.activePane]!.tabs.find((tab) => tab.input.key === "conversation")?.pinned).toBe(false);
    } finally {
      storeSession(root, null);
    }
  });

  it("bounds retained conversations without closing file tabs or ending their underlying tasks", async () => {
    const editor = start();
    await editor.openFile("/a.txt");
    for (let i = 0; i < KEPT_KIND_EDITORS + 3; i++)
      await editor.openInput({ kind: "managed", key: `conversation-${i}` });
    expect(editor.openTabs().filter((tab) => tab.input.kind === "managed")).toHaveLength(KEPT_KIND_EDITORS);
    expect(editor.openPaths()).toEqual(["/a.txt"]);
    await editor.openInput({ kind: "managed", key: "conversation-0" });
    expect(editor.activeInput()?.key).toBe("conversation-0");
    expect(editor.openTabs().filter((tab) => tab.input.kind === "managed")).toHaveLength(KEPT_KIND_EDITORS);
  });
});
