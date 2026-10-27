import { describe, expect, it } from "vitest";
import { menuItems, onLoneAlt } from "./MainMenu";

describe("lone Alt opens the main menu", () => {
  const key = (type: string, k: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init }));
  it.each<[string, () => void, number]>([
    ["Alt alone", () => (key("keydown", "Alt", { altKey: true }), key("keyup", "Alt")), 1],
    [
      "Alt+1",
      () => (
        key("keydown", "Alt", { altKey: true }),
        key("keydown", "1", { altKey: true }),
        key("keyup", "1"),
        key("keyup", "Alt")
      ),
      0,
    ],
    [
      "Ctrl+Alt",
      () => (
        key("keydown", "Control", { ctrlKey: true }),
        key("keydown", "Alt", { ctrlKey: true, altKey: true }),
        key("keyup", "Alt")
      ),
      0,
    ],
    [
      "Alt+click",
      () => (
        key("keydown", "Alt", { altKey: true }),
        window.dispatchEvent(new Event("pointerdown")),
        key("keyup", "Alt")
      ),
      0,
    ],
    [
      "held Alt (repeat)",
      () => (
        key("keydown", "Alt", { altKey: true }),
        key("keydown", "Alt", { altKey: true, repeat: true }),
        key("keyup", "Alt")
      ),
      0,
    ],
  ])("%s", (_, press, expected) => {
    let opened = 0;
    const off = onLoneAlt(window, () => void opened++);
    press();
    off();
    expect(opened).toBe(expected);
  });
});

describe("main menu model", () => {
  it("maps menu nodes to menu items, localising spec labels only", () => {
    const items = menuItems([
      { kind: "action", id: "file.save", label: "Save All", hint: null, arg: null },
      { kind: "separator" },
      {
        kind: "submenu",
        id: "openRecent",
        label: "Open Recent",
        children: [
          {
            kind: "action",
            id: "file.openRecentProject",
            label: "openidea  —  ~/openidea",
            hint: null,
            arg: "/p/openidea",
          },
          { kind: "placeholder", id: "recent.none", label: "No Recent Projects" },
        ],
      },
    ]);
    expect(items[0]).toEqual({ kind: "action", action: "file.save", arg: undefined, label: "Save All" });
    expect(items[1]).toEqual({ kind: "separator" });
    expect(items[2]).toMatchObject({ id: "openRecent", label: "Open Recent" });
    const sub = (items[2] as { submenu: unknown[] }).submenu;
    expect(sub[0]).toEqual({
      kind: "action",
      action: "file.openRecentProject",
      arg: "/p/openidea",
      label: "openidea  —  ~/openidea",
    });
    expect(sub[1]).toMatchObject({ label: "No Recent Projects", disabled: true });
  });
});
