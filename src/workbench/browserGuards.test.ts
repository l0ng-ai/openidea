import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hideContextMenu, selectableText, showContextMenu, useContextMenuStore } from "@/ui";
import { installBrowserGuards } from "./browserGuards";

let dispose: () => void;

beforeEach(() => {
  dispose = installBrowserGuards({ blockReload: false });
});

afterEach(() => {
  dispose();
  hideContextMenu();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

function rightClick(el: Element) {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 });
  el.dispatchEvent(e);
  return e;
}

describe("browser guards: context menu", () => {
  it("never shows the native menu, and nothing on chrome", () => {
    document.body.innerHTML = `<button id="b">Run</button>`;
    const e = rightClick(document.getElementById("b")!);
    expect(e.defaultPrevented).toBe(true);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it("shows Copy on selectable read-only text (issue #36)", () => {
    document.body.innerHTML = `<div class="${selectableText}"><p id="p">Hello</p></div>`;
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p")!);
    window.getSelection()!.addRange(range);
    const e = rightClick(document.getElementById("p")!);
    expect(e.defaultPrevented).toBe(true);
    const menu = useContextMenuStore.getState().menu;
    expect(menu).toMatchObject({ x: 5, y: 6 });
    expect(menu!.items[0]).toMatchObject({ label: "Copy", disabled: false });
  });

  it("keeps a component's own context menu", () => {
    document.body.innerHTML = `<div class="${selectableText}"><p id="p">Hello</p></div>`;
    const p = document.getElementById("p")!;
    p.addEventListener("contextmenu", (e) => showContextMenu(e, [{ label: "Own" }]));
    rightClick(p);
    expect(useContextMenuStore.getState().menu!.items[0]).toMatchObject({ label: "Own" });
  });

  it("keeps out when a handler already prevented the default", () => {
    document.body.innerHTML = `<div class="${selectableText}"><p id="p">Hello</p></div>`;
    const p = document.getElementById("p")!;
    p.addEventListener("contextmenu", (e) => e.preventDefault());
    rightClick(p);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it("blocks browser shortcuts by typed letter", () => {
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press({ key: "p", code: "KeyR", ctrlKey: true })).toBe(true);
    expect(press({ key: "l", code: "KeyP", ctrlKey: true })).toBe(false);
  });
});
