import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorController, openFilePaths, useEditorStatus, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { useDocMeta } from "./model/document";
import { resetDistractionFree, setDistractionFree } from "@/workbench/distractionFree";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { resolveMenuItems } from "@/ui";
import { getContext } from "@/platform/context";
import { installKeyboardDispatcher } from "@/platform/keymap";
import { TEXT_WHEN } from "./actions";

let ctrl: EditorController | null = null;

afterEach(() => {
  ctrl?.stop();
  ctrl = null;
  useTabs.setState(initialTabsState(), true);
  useEditorStatus.setState({ status: null });
});

describe("EditorController", () => {
  it("leaves modified Enter to a non-text editor after switching from a focused file", async () => {
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "one\ntwo\n" }));
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    const slot = ctrl.activeSlot!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = slot.mount(host);
    ctrl.onMounted(slot);
    view.focus();
    await vi.waitFor(() => expect(getContext().editorTextFocus).toBe(true));

    const splitLine = vi.fn();
    const dispose = registerActions([
      {
        id: "code.splitLine",
        title: "Split Line",
        when: TEXT_WHEN,
        run: splitLine,
      },
    ]);
    const uninstall = installKeyboardDispatcher(window);
    const message = document.createElement("textarea");
    const send = vi.fn();
    message.addEventListener("keydown", send);
    try {
      await ctrl.openInput({ kind: "agent-session", key: "task" });
      slot.unmount();
      host.appendChild(message);
      message.focus();
      message.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(splitLine).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
      expect(getContext().editorTextFocus).toBe(false);

      await ctrl.openFile("/p/a.ts", { focus: false });
      const reopened = slot.mount(host);
      ctrl.onMounted(slot);
      reopened.focus();
      await vi.waitFor(() => expect(getContext().editorTextFocus).toBe(true));
      reopened.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(splitLine).toHaveBeenCalledOnce();
    } finally {
      uninstall();
      dispose();
      slot.unmount();
      host.remove();
    }
  });

  it("updates the caret status synchronously on programmatic selection changes", async () => {
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "one\ntwo\nthree\n" }));
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    const s = useTabs.getState();
    const slot = ctrl.slotFor(s.panes[s.activePane]!.active!)!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = slot.mount(host);
    ctrl.onMounted(slot);
    view.dispatch({ selection: { anchor: 6 } });
    expect(useEditorStatus.getState().status).toMatchObject({ path: "/p/a.ts", line: 1, col: 2, offset: 6 });
    view.dispatch({ selection: { anchor: 4, head: 9 } });
    expect(useEditorStatus.getState().status).toMatchObject({ line: 2, col: 1, selectedChars: 5, selectedLines: 1 });
    slot.unmount();
    host.remove();
  });

  it("reconfigures open editors when Distraction Free Mode toggles", async () => {
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "one\ntwo\n" }));
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    const s = useTabs.getState();
    const slot = ctrl.slotFor(s.panes[s.activePane]!.active!)!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = slot.mount(host);
    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    setDistractionFree(true);
    expect(view.dom.querySelector(".cm-lineNumbers")).toBeNull();
    expect(view.dom.classList.contains("cm-openidea-distractionFree")).toBe(true);
    setDistractionFree(false);
    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(view.dom.classList.contains("cm-openidea-distractionFree")).toBe(false);
    resetDistractionFree();
    slot.unmount();
    host.remove();
  });

  it("lists open file paths across panes", async () => {
    ctrl = new EditorController(createMemoryBackend());
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    await ctrl.openFile("/p/b.ts", { focus: false, side: true });
    await ctrl.openFile("/p/a.ts", { focus: false, side: true });
    expect(openFilePaths(useTabs.getState())).toEqual(["/p/a.ts", "/p/b.ts"]);
  });

  it("opens a copy of a tab in the opposite group, splitting when there is none", async () => {
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "", "/p/b.ts": "" }));
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    await ctrl.openFile("/p/b.ts", { focus: false });
    const paths = (paneId: string) => useTabs.getState().panes[paneId]!.tabs.map((t) => t.input.path);
    const first = useTabs.getState().activePane;
    const tabA = useTabs.getState().panes[first]!.tabs[0]!.id;
    ctrl.openInOpposite(first, tabA);
    const second = useTabs.getState().activePane;
    expect(second).not.toBe(first);
    expect(paths(second)).toEqual(["/p/a.ts"]);
    ctrl.openInOpposite(first, useTabs.getState().panes[first]!.tabs[1]!.id);
    expect(paths(second)).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(paths(first)).toEqual(["/p/a.ts", "/p/b.ts"]);
  });

  it("closes read-only tabs and keeps a preview tab open from the tab menu", async () => {
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "", "/p/b.ts": "", "/p/c.ts": "" }));
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    await ctrl.openFile("/p/b.ts", { focus: false });
    await ctrl.openFile("/p/c.ts", { focus: false, preview: true });
    const pane = () => useTabs.getState().panes[useTabs.getState().activePane]!;
    const labels = () => resolveMenuItems(ctrl!.tabMenu(pane().id, pane().tabs[2]!)).map((i) => i.label);
    expect(labels()).toContain("Keep Tab Open");
    expect(labels()).not.toContain("Close All Read-Only Tabs");
    ctrl.keepTab(pane().id, pane().tabs[2]!.id);
    expect(pane().tabs[2]!.preview).toBe(false);
    useDocMeta.setState({ "/p/b.ts": { ...useDocMeta.getState()["/p/b.ts"]!, readOnly: true } });
    expect(labels()).toContain("Close All Read-Only Tabs");
    await ctrl.closeReadOnly(pane().id);
    expect(pane().tabs.map((t) => t.input.path)).toEqual(["/p/a.ts", "/p/c.ts"]);
  });

  it("reopens the LightEdit files the next time a window switches to LightEdit", async () => {
    ctrl = new EditorController(createMemoryBackend({ "/x/a.txt": "a", "/y/b.md": "b" }));
    ctrl.start();
    useProject.setState({ lightEdit: true });
    await ctrl.openFile("/x/a.txt", { focus: false });
    await ctrl.openFile("/y/b.md", { focus: false });
    // The LightEdit window closes with its tabs open.
    useProject.setState({ lightEdit: false });
    expect(openFilePaths(useTabs.getState())).toEqual([]);
    useProject.setState({ lightEdit: true });
    await vi.waitFor(() => expect(openFilePaths(useTabs.getState())).toEqual(["/x/a.txt", "/y/b.md"]));
    // Clearing the session must not resurrect its other files on the next explicit open.
    await ctrl.closeEverything();
    useProject.setState({ lightEdit: false });
    useProject.setState({ lightEdit: true });
    await ctrl.openFile("/x/a.txt", { focus: false });
    expect(openFilePaths(useTabs.getState())).toEqual(["/x/a.txt"]);
    useProject.setState({ lightEdit: false });
  });

  it("closes a tab by its input key", async () => {
    ctrl = new EditorController(createMemoryBackend());
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    await ctrl.openFile("/p/b.ts", { focus: false });
    const key = Object.values(useTabs.getState().panes)
      .flatMap((p) => p.tabs)
      .find((t) => t.input.path === "/p/b.ts")!.input.key;
    await ctrl.closeInput(key);
    expect(openFilePaths(useTabs.getState())).toEqual(["/p/a.ts"]);
  });

  it("builds IDEA's editor tab menu", async () => {
    useProject.setState({
      project: { name: "p", root: "/p", isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    const ids = [
      "navigate.selectIn",
      "project.revealInFinder",
      "vcs.localHistory",
      "vcs.commit",
      "project.copyAbsolutePath",
      "project.rename",
      "file.settings",
    ];
    const dispose = registerActions(ids.map((id) => ({ id, title: id, run: () => undefined })));
    ctrl = new EditorController(createMemoryBackend({ "/p/a.ts": "", "/p/b.ts": "" }));
    ctrl.start();
    await ctrl.openFile("/p/a.ts", { focus: false });
    await ctrl.openFile("/p/b.ts", { focus: false });
    const s = useTabs.getState();
    const pane = s.panes[s.activePane]!;
    const items = resolveMenuItems(ctrl.tabMenu(pane.id, pane.tabs[0]!));
    expect(items.find((i) => i.label === "Close Tabs to the Left")?.disabled).toBe(true);
    expect(items.find((i) => i.label === "Close Tabs to the Right")?.disabled).toBe(false);
    dispose();
    useProject.setState({ project: null, settings: null });
  });
});
