import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEditorKind, type EditorKindContribution } from "@/workbench/contributions";
import { t } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { confirm } from "@/workbench/messages";
import type * as Messages from "@/workbench/messages";
import { EditorController, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";

vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<typeof Messages>()),
  confirm: vi.fn(),
}));

let controller: EditorController | null = null;
afterEach(() => {
  controller?.stop();
  controller = null;
  useTabs.setState(initialTabsState(), true);
  useProject.setState({ project: null, settings: null });
  vi.mocked(confirm).mockReset();
});

/** A kind whose tabs answer `isBusy`; the title is the input key. */
const busyKind = (isBusy: EditorKindContribution["isBusy"]) =>
  registerEditorKind({ kind: "busy-probe", title: (i) => i.key, component: () => null, isBusy });

const start = () => {
  controller = new EditorController(createMemoryBackend({}));
  controller.start();
  return controller;
};
const pane = () => useTabs.getState().panes[useTabs.getState().activePane]!;
const keys = () => pane().tabs.map((tab) => tab.input.key);
const question = (name: string) => ({
  title: t("editor.closeBusy.title", { name }),
  message: t("editor.closeBusy.message", { name }),
  ok: t("editor.closeBusy.terminate"),
});

describe("editor kinds' isBusy on close", () => {
  it("asks before closing a busy tab and keeps it on Cancel", async () => {
    const dispose = busyKind(() => true);
    vi.mocked(confirm).mockResolvedValue(false);
    const ctrl = start();
    try {
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:1" });
      expect(await ctrl.closeTab(pane().id, pane().tabs[0]!.id)).toBe(false);
      expect(confirm).toHaveBeenCalledExactlyOnceWith(question("busy-probe:1"));
      expect(keys()).toEqual(["busy-probe:1"]);
    } finally {
      dispose();
    }
  });

  it("closes the busy tab once terminating is confirmed", async () => {
    const closed = vi.fn();
    const dispose = registerEditorKind({
      kind: "busy-probe",
      title: (i) => i.key,
      component: () => null,
      isBusy: () => true,
      onClose: closed,
    });
    vi.mocked(confirm).mockResolvedValue(true);
    const ctrl = start();
    const input = { kind: "busy-probe", key: "busy-probe:1" };
    try {
      await ctrl.openInput(input);
      expect(await ctrl.closeTab(pane().id, pane().tabs[0]!.id)).toBe(true);
      expect(keys()).toEqual([]);
      expect(closed).toHaveBeenCalledExactlyOnceWith(input);
    } finally {
      dispose();
    }
  });

  it("awaits an async answer, and closes a tab that is not busy without asking", async () => {
    const dispose = busyKind(async (i) => i.key === "busy-probe:1");
    vi.mocked(confirm).mockResolvedValue(false);
    const ctrl = start();
    try {
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:1" });
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:2" });
      const idle = pane().tabs.find((tab) => tab.input.key === "busy-probe:2")!;
      expect(await ctrl.closeTab(pane().id, idle.id)).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(await ctrl.closeTab(pane().id, pane().tabs[0]!.id)).toBe(false);
      expect(confirm).toHaveBeenCalledExactlyOnceWith(question("busy-probe:1"));
    } finally {
      dispose();
    }
  });

  it("counts a failing isBusy as not busy, so the tab still closes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispose = busyKind(() => {
      throw new Error("probe failed");
    });
    const ctrl = start();
    try {
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:1" });
      expect(await ctrl.closeTab(pane().id, pane().tabs[0]!.id)).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      dispose();
      warn.mockRestore();
    }
  });

  it("asks only when the last tab of a busy input closes", async () => {
    const dispose = busyKind(() => true);
    vi.mocked(confirm).mockResolvedValue(true);
    const ctrl = start();
    const input = { kind: "busy-probe", key: "busy-probe:1" };
    try {
      await ctrl.openInput(input);
      ctrl.split(useTabs.getState().activePane, "row");
      const panes = Object.values(useTabs.getState().panes);
      // Another pane still shows the input: nothing ends, nothing to ask.
      expect(await ctrl.closeTab(panes[0]!.id, panes[0]!.tabs[0]!.id)).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(await ctrl.closeInput(input.key)).toBe(true);
      expect(confirm).toHaveBeenCalledExactlyOnceWith(question("busy-probe:1"));
    } finally {
      dispose();
    }
  });
});

describe("editor kinds' isBusy on tab-limit eviction", () => {
  const limitOne = () =>
    useProject.setState({ settings: { editor: { tabs: { tabLimit: 1, closingPolicy: "lru" } } } as never });

  it.each([
    ["a sync answer", (key: string) => key === "busy-probe:1"],
    ["an async answer", (key: string) => Promise.resolve(key === "busy-probe:1")],
  ])("skips a busy tab without asking (%s)", async (_name, busy) => {
    const dispose = busyKind((i) => busy(i.key));
    const ctrl = start();
    limitOne();
    try {
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:1" });
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:2" });
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:3" });
      // The least recently used tab is the busy one: it stays, the idle one makes room instead.
      expect(keys()).toEqual(["busy-probe:1", "busy-probe:3"]);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("evicts the least recently used tab when none is busy", async () => {
    const dispose = busyKind(() => false);
    const ctrl = start();
    limitOne();
    try {
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:1" });
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:2" });
      await ctrl.openInput({ kind: "busy-probe", key: "busy-probe:3" });
      expect(keys()).toEqual(["busy-probe:3"]);
    } finally {
      dispose();
    }
  });
});
