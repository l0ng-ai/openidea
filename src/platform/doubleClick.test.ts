import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { installRepeatedDoubleClick } from "./doubleClick";

describe("installRepeatedDoubleClick", () => {
  let uninstall: () => void;
  let el: HTMLElement;
  let dbl: ReturnType<typeof vi.fn<(detail: number, target: EventTarget | null) => void>>;

  beforeEach(() => {
    uninstall = installRepeatedDoubleClick();
    el = document.createElement("div");
    document.body.append(el);
    dbl = vi.fn();
    el.addEventListener("dblclick", (e) => dbl((e as MouseEvent).detail, e.target));
  });
  afterEach(() => {
    uninstall();
    el.remove();
  });

  /** A burst as WebKit delivers it: `dblclick` only after the second click. */
  const burst = (clicks: number) => {
    for (let detail = 1; detail <= clicks; detail++) {
      fireEvent.click(el, { detail });
      if (detail === 2) fireEvent.doubleClick(el, { detail });
    }
  };

  it("turns each later even click of a burst into one double-click on its target", () => {
    burst(6);
    expect(dbl.mock.calls).toEqual([
      [2, el],
      [4, el],
      [6, el],
    ]);
  });

  it("leaves odd clicks, other buttons and the first double-click alone", () => {
    burst(3);
    fireEvent.click(el, { detail: 4, button: 1 });
    expect(dbl.mock.calls).toEqual([[2, el]]);
  });

  it("drops the engine's own double-click when it also fires one", () => {
    fireEvent.click(el, { detail: 4 });
    fireEvent.doubleClick(el, { detail: 4 });
    expect(dbl).toHaveBeenCalledTimes(1);
  });

  it("keeps the click handlers ahead of the double-click", () => {
    const order: string[] = [];
    el.addEventListener("click", () => order.push("click"));
    el.addEventListener("dblclick", () => order.push("dblclick"));
    fireEvent.click(el, { detail: 4 });
    expect(order).toEqual(["click", "dblclick"]);
  });

  it("does nothing once uninstalled", () => {
    uninstall();
    fireEvent.click(el, { detail: 4 });
    expect(dbl).not.toHaveBeenCalled();
  });
});
