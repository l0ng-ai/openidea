import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWindowDrag } from "./window-drag";

describe("installWindowDrag", () => {
  let uninstall: () => void;
  let bar: HTMLElement;
  let region: HTMLElement;
  let button: HTMLButtonElement;
  const start = vi.fn();
  const toggleMaximize = vi.fn();

  beforeEach(() => {
    start.mockClear();
    toggleMaximize.mockClear();
    uninstall = installWindowDrag({ enabled: true, start, toggleMaximize });
    bar = document.body.appendChild(document.createElement("header"));
    region = bar.appendChild(document.createElement("div"));
    region.setAttribute("data-window-drag-region", "");
    button = bar.appendChild(document.createElement("button"));
  });
  afterEach(() => {
    uninstall();
    bar.remove();
  });

  const mouse = (el: Element, type: string, init: MouseEventInit = {}) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0, detail: 1, ...init });
    el.dispatchEvent(e);
    return e;
  };

  it("starts a native drag only while the primary button is held", () => {
    const e = mouse(region, "mousedown", { buttons: 1 });
    expect(start).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
  });

  it("does not drag for a tap whose mousedown arrives after the release", () => {
    mouse(region, "mousedown", { buttons: 0 });
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores presses on controls, other buttons and the region's children", () => {
    mouse(button, "mousedown", { buttons: 1 });
    mouse(region, "mousedown", { buttons: 2, button: 2 });
    const child = region.appendChild(document.createElement("span"));
    mouse(child, "mousedown", { buttons: 1 });
    expect(start).not.toHaveBeenCalled();
  });

  it("zooms on the mouseup of a double click that did not move, not on a drag away", () => {
    mouse(region, "mousedown", { detail: 2, clientX: 5, clientY: 5, buttons: 1 });
    expect(start).not.toHaveBeenCalled();
    mouse(region, "mouseup", { detail: 2, clientX: 5, clientY: 5 });
    expect(toggleMaximize).toHaveBeenCalledOnce();

    mouse(region, "mousedown", { detail: 2, clientX: 5, clientY: 5, buttons: 1 });
    mouse(region, "mouseup", { detail: 2, clientX: 40, clientY: 5 });
    expect(toggleMaximize).toHaveBeenCalledOnce();
  });

  it("does nothing when disabled or after uninstall", () => {
    uninstall();
    uninstall = installWindowDrag({ enabled: false, start, toggleMaximize });
    mouse(region, "mousedown", { buttons: 1 });
    expect(start).not.toHaveBeenCalled();
  });
});
