import { describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (e: { payload: unknown }) => void>();
const emitTo = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (...args: unknown[]) => (emitTo as (...a: unknown[]) => Promise<void>)(...args),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "settings-main",
    listen: (event: string, cb: (e: { payload: unknown }) => void) => {
      listeners.set(event, cb);
      return Promise.resolve(() => listeners.delete(event));
    },
  }),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true };
});

import { executeAction, getAction, registerAction, useActions } from "@/platform/actions";
import { registerSettingsPage, registerSettingsPages, useSettingsPages } from "@/workbench/contributions";
import { installActionProxies, type ActionInfo } from "../window/bridge";

describe("registerSettingsPages", () => {
  it("registers and disposes a page batch in one store update each while keeping later overrides", () => {
    let updates = 0;
    const off = useSettingsPages.subscribe(() => {
      updates += 1;
    });
    const disposeBatch = registerSettingsPages([
      { id: "batch.a", title: "A" },
      { id: "batch.b", title: "B" },
      { id: "batch.c", title: "C" },
    ]);
    const disposeOverride = registerSettingsPage({ id: "batch.b", title: "B2" });
    try {
      expect(updates).toBe(2);
      expect(useSettingsPages.getState().pages.get("batch.a")?.title).toBe("A");
      expect(useSettingsPages.getState().pages.get("batch.b")?.title).toBe("B2");
      disposeBatch();
      expect(updates).toBe(3);
      expect(useSettingsPages.getState().pages.has("batch.a")).toBe(false);
      expect(useSettingsPages.getState().pages.get("batch.b")?.title).toBe("B2");
      expect(useSettingsPages.getState().pages.has("batch.c")).toBe(false);
    } finally {
      disposeOverride();
      off();
    }
  });
});

describe("installActionProxies", () => {
  it("batches parent action syncs and keeps local actions authoritative", async () => {
    const localRun = vi.fn();
    const disposeLocal = registerAction({ id: "local.win", title: "Local", run: localRun });
    const dispose = installActionProxies("main");
    await vi.waitFor(() => expect(listeners.has("openidea://settings/actions")).toBe(true));

    let updates = 0;
    const off = useActions.subscribe(() => {
      updates += 1;
    });
    const batch: ActionInfo[] = [
      { id: "local.win", title: "Remote Should Lose" },
      ...Array.from({ length: 50 }, (_, i) => ({ id: `remote.act.${i}`, title: `Remote ${i}` })),
    ];
    try {
      listeners.get("openidea://settings/actions")!({ payload: batch });
      // 50 remote actions register in a single store update instead of 50.
      expect(updates).toBe(1);
      expect(getAction("local.win")?.title).toBe("Local");
      expect(getAction("remote.act.49")?.title).toBe("Remote 49");

      await executeAction("remote.act.3", "arg3");
      expect(emitTo).toHaveBeenCalledWith("main", "openidea://settings/exec", { id: "remote.act.3", arg: "arg3" });

      // Re-syncing disposes previous proxies in 1 update and registers the new list in 1 update.
      listeners.get("openidea://settings/actions")!({ payload: [{ id: "remote.act.0", title: "Updated 0" }] });
      expect(updates).toBe(3);
      expect(getAction("remote.act.49")).toBeUndefined();
      expect(getAction("remote.act.0")?.title).toBe("Updated 0");
    } finally {
      off();
      dispose();
      disposeLocal();
    }
  });
});
