import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPointerFocus } from "./pointerFocus";

let uninstall: () => void;
beforeEach(() => {
  document.body.innerHTML = `
    <button id="tab" role="tab"><span id="label">go-app</span></button>
    <button id="other">Other</button>
    <div id="row" role="treeitem" tabindex="0">row</div>`;
  uninstall = installPointerFocus();
});
afterEach(() => uninstall());

const el = (id: string) => document.getElementById(id)!;
const press = (id: string) => el(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const marked = (id: string) => el(id).hasAttribute("data-pointer-focus");

describe("installPointerFocus", () => {
  it("marks the control under a press, not other focusable elements", () => {
    press("label");
    press("row");
    expect([marked("tab"), marked("row")]).toEqual([true, false]);
  });

  it("keeps the mark when focus comes back without keyboard navigation (a popup closed with Esc)", () => {
    press("tab");
    el("tab").focus();
    el("other").focus();
    key("Escape");
    el("tab").focus();
    expect(marked("tab")).toBe(true);
  });

  it("clears the mark when Tab or an arrow key moves focus onto the control", () => {
    press("tab");
    press("other");
    key("Tab");
    el("tab").focus();
    expect(marked("tab")).toBe(false);
    key("ArrowRight");
    el("other").focus();
    expect(marked("other")).toBe(false);
  });
});
