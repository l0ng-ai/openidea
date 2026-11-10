import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installImeKeyGuard } from "./ime";

let uninstall: () => void;
let seen: KeyboardEvent[];
const onKey = (e: KeyboardEvent) => seen.push(e);

beforeEach(() => {
  document.body.innerHTML = `
    <input id="field" />
    <textarea id="area"></textarea>
    <div class="xterm"><textarea id="xterm"></textarea></div>
    <div id="editor" contenteditable="true"></div>`;
  seen = [];
  uninstall = installImeKeyGuard(window);
  document.addEventListener("keydown", onKey);
  window.addEventListener("keydown", onKey, true);
});
afterEach(() => {
  uninstall();
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("keydown", onKey, true);
});

const el = (id: string) => document.getElementById(id)!;
const press = (id: string, init: KeyboardEventInit & { keyCode?: number }) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  el(id).dispatchEvent(event);
  return event;
};

describe("installImeKeyGuard", () => {
  it("hides the Enter that commits a candidate (keyCode 229, isComposing already false) from a text field", () => {
    const handler = vi.fn();
    el("field").addEventListener("keydown", handler);
    press("field", { key: "Enter", keyCode: 229 });
    expect(handler).not.toHaveBeenCalled();
    // Later window-level capture listeners (shortcuts, Esc-to-close) are cut off too.
    expect(seen).toHaveLength(0);
  });

  it("hides keys pressed while composing, on <textarea> too", () => {
    const handler = vi.fn();
    el("area").addEventListener("keydown", handler);
    press("area", { key: "ArrowDown", isComposing: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not cancel the default action, so the input method keeps working", () => {
    expect(press("field", { key: "Enter", keyCode: 229 }).defaultPrevented).toBe(false);
  });

  it("passes ordinary keys through", () => {
    const handler = vi.fn();
    el("field").addEventListener("keydown", handler);
    press("field", { key: "Enter", keyCode: 13 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves xterm's textarea and contenteditable editors to their own IME handling", () => {
    const handler = vi.fn();
    el("xterm").addEventListener("keydown", handler);
    el("editor").addEventListener("keydown", handler);
    press("xterm", { key: "Enter", keyCode: 229 });
    press("editor", { key: "Enter", keyCode: 229 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("stops listening once uninstalled", () => {
    uninstall();
    const handler = vi.fn();
    el("field").addEventListener("keydown", handler);
    press("field", { key: "Enter", keyCode: 229 });
    expect(handler).toHaveBeenCalledTimes(1);
    uninstall = installImeKeyGuard(window);
  });
});
