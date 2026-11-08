import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { useKeymap } from "@/platform/keymap";
import * as ipc from "@/platform/ipc";
import { resetDistractionFree, setDistractionFree } from "@/workbench/distractionFree";
import { registerToolWindow } from "@/workbench/contributions";
import { _reloadLayouts, saveLayout } from "@/workbench/toolwindows/layouts";
import { clearContext, setContext } from "@/platform/context";
import {
  buildMenuConfig,
  disabledMenuActions,
  dynamicMenuItems,
  installMenuBridge,
  menuAccelerator,
  menuActionIds,
  routeMenuEvent,
} from "../menuBridge";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}));

describe("menu state from the frontend", () => {
  it("refreshes the focused window's enablement even if context changes during the debounce", async () => {
    vi.useFakeTimers();
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(ipc.commands, "appBuildInfo").mockRejectedValue(new Error("No build info in tests"));
    vi.spyOn(ipc.commands, "menuConfigure").mockResolvedValue();
    vi.spyOn(ipc.commands, "menuModel").mockResolvedValue([
      { kind: "action", id: "test.menuFocus", label: "Test", hint: null, arg: null },
    ]);
    const pushDisabled = vi.spyOn(ipc.commands, "menuSetDisabled").mockResolvedValue();
    const offAction = registerAction({ id: "test.menuFocus", title: "Test", run: () => {} });
    const dispose = installMenuBridge();
    try {
      await vi.advanceTimersByTimeAsync(120);
      expect(pushDisabled).toHaveBeenCalledWith([]);
      pushDisabled.mockClear();

      window.dispatchEvent(new Event("focus"));
      setContext("testMenuFocusNoise", true);
      await vi.advanceTimersByTimeAsync(120);

      expect(pushDisabled).toHaveBeenCalledExactlyOnceWith([]);
    } finally {
      dispose();
      offAction();
      clearContext("testMenuFocusNoise");
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("lists registered tool windows by title and saved layouts", () => {
    localStorage.clear();
    _reloadLayouts();
    const offs = [
      registerToolWindow({ id: "zeta", title: "Terminal", icon: "terminal", anchor: "bottom", component: () => null }),
      registerToolWindow({ id: "alpha", title: "Problems", icon: "problems", anchor: "bottom", component: () => null }),
    ];
    saveLayout("Review");
    const dyn = dynamicMenuItems();
    expect(dyn.toolWindows!.map((i) => [i.action, i.label])).toEqual([
      ["toolwindow.alpha", "Problems"],
      ["toolwindow.zeta", "Terminal"],
    ]);
    expect(dyn.toolWindowLayouts).toEqual([{ action: "layout.restore", arg: "Review", label: "Review" }]);
    expect(buildMenuConfig("macos").dynamic).toEqual(dyn);
    offs.forEach((d) => d());
    localStorage.clear();
    _reloadLayouts();
  });

  it("disables the registered actions that cannot run now", () => {
    const offs = [
      registerAction({ id: "test.menu.always", title: "A", run: () => {} }),
      registerAction({ id: "test.menu.whenEditor", title: "B", when: "testMenuEditor", run: () => {} }),
    ];
    const ids = menuActionIds([
      {
        kind: "submenu",
        id: "x",
        label: "X",
        children: [
          { kind: "action", id: "test.menu.whenEditor", label: "B", hint: null, arg: null },
          { kind: "action", id: "test.menu.always", label: "A", hint: null, arg: null },
        ],
      },
      { kind: "action", id: "not.registered", label: "C", hint: null, arg: null },
    ]);
    expect([...ids].sort()).toEqual(["not.registered", "test.menu.always", "test.menu.whenEditor"]);
    // Unregistered ids stay enabled: the action may register later (lazy features).
    expect(disabledMenuActions(ids)).toEqual(["test.menu.whenEditor"]);
    setContext("testMenuEditor", true);
    expect(disabledMenuActions(ids)).toEqual([]);
    setContext("testMenuEditor", false);
    offs.forEach((d) => d());
  });
});

afterEach(() => {
  _resetI18nForTests();
  useKeymap.setState({ overrides: {} });
});

describe("menu event routing", () => {
  it("runs the action named by the event, passing the argument", async () => {
    const run = vi.fn();
    const off = registerAction({ id: "test.menuRoute", title: "Test", run });
    await expect(routeMenuEvent({ action: "test.menuRoute", arg: "/p/openidea" })).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: "/p/openidea" }));
    await routeMenuEvent({ action: "test.menuRoute", arg: null });
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ arg: undefined }));
    off();
  });

  it("ignores malformed payloads and unknown actions", async () => {
    const run = vi.fn(async () => true);
    await expect(routeMenuEvent(null, run)).resolves.toBe(false);
    await expect(routeMenuEvent({ id: "x" }, run)).resolves.toBe(false);
    await expect(routeMenuEvent({ action: "" }, run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    await expect(routeMenuEvent({ action: "no.such.action" })).resolves.toBe(false);
  });

  it("does not run disabled actions", async () => {
    const run = vi.fn();
    const off = registerAction({ id: "test.gatedMenu", title: "T", when: "neverTrueKey", run });
    await expect(routeMenuEvent({ action: "test.gatedMenu" })).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    off();
  });
});

describe("menu config", () => {
  it("carries keymap shortcuts as native accelerators", () => {
    const mac = buildMenuConfig("macos");
    expect(mac.accelerators["file.save"]).toBe("Meta+S");
    expect(mac.accelerators["navigate.gotoFile"]).toBe("Shift+Meta+O");
    expect(mac.accelerators["navigate.searchEverywhere"]).toBeUndefined();
  });

  it("follows user keymap overrides", () => {
    useKeymap.setState({ overrides: { "file.save": ["Ctrl+Alt+S"] } });
    expect(buildMenuConfig("macos").accelerators["file.save"]).toBe("Ctrl+Alt+S");
  });

  it("sends localised labels with platform-specific variants", async () => {
    expect(buildMenuConfig("macos").labels["menu.app.quit"]).toBe("Quit OpenIDEA");
    expect(buildMenuConfig("windows").labels["menu.app.quit"]).toBe("Exit");
    expect(buildMenuConfig("windows").labels["menu.help.showLog"]).toBe("Show Log in Explorer");
    await setLocale("zh");
    const zh = buildMenuConfig("macos");
    expect(zh.locale).toBe("zh");
    expect(zh.labels["menu.file"]).toBe("文件");
    expect(zh.labels["menu.file.save"]).toBe("全部保存");
  });

  it("gives keys a native menu can show as they are", () => {
    for (const binding of [
      "Meta+[",
      "Shift+Meta+Backspace",
      "Meta+Delete",
      "Meta+F12",
      "Alt+F1",
      "Ctrl+Shift+Down",
      "Alt+Enter",
      "Escape",
      "Meta+,",
      "Alt+Meta+PageDown",
      "Meta+NumpadAdd",
      "Meta+NumpadMultiply",
      "F13",
      "Shift+F24",
      "Meta+`",
      "Meta+\\",
      "Meta+'",
      "Meta+;",
    ])
      expect(menuAccelerator(binding)).toBe(binding);
    expect(menuAccelerator("shift+meta+o")).toBe("Shift+Meta+O");
  });

  it("leaves out bindings a native menu cannot show", () => {
    for (const binding of [
      "Shift Shift",
      "Ctrl Ctrl",
      "Alt Alt+Up",
      "Meta+Alt+N Meta+Alt+N",
      "Meta+NumpadMultiply 1",
      "Meta+Button1",
      "SwipeLeft",
    ])
      expect(menuAccelerator(binding)).toBeUndefined();
  });
});

describe("window-scoped menu labels", () => {
  it("flips Enter / Exit Distraction Free Mode with the window's mode", () => {
    expect(buildMenuConfig("macos").labels["menu.editor.toggleZen"]).toBe("Enter Distraction Free Mode");
    expect(buildMenuConfig("macos").accelerators["editor.toggleZen"]).toBeUndefined();
    setDistractionFree(true);
    expect(buildMenuConfig("macos").labels["menu.editor.toggleZen"]).toBe("Exit Distraction Free Mode");
    resetDistractionFree();
  });
});
