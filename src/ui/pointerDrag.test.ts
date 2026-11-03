import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropZoneAt, isOutsideWindow, startPointerDrag } from "./pointerDrag";

const fire = (type: string, buttons: number, x = 0, y = 0) =>
  window.dispatchEvent(new MouseEvent(type, { bubbles: true, buttons, clientX: x, clientY: y }));

describe("startPointerDrag with a reordered macOS tap", () => {
  beforeEach(() => {
    document.elementFromPoint = () => null; // jsdom lacks it; drop hit-testing needs it
  });
  afterEach(() => (document.body.innerHTML = ""));
  const start = () => {
    const source = document.body.appendChild(document.createElement("div"));
    const onStart = vi.fn();
    const onEnd = vi.fn();
    startPointerDrag(
      { button: 0, clientX: 0, clientY: 0, altKey: false },
      source,
      { type: "t", payload: "" },
      { onStart, onEnd },
    );
    return { onStart, onEnd };
  };

  it("never starts a drag from moves with no button held", () => {
    const { onStart, onEnd } = start();
    fire("pointermove", 0, 40, 0);
    fire("pointerup", 0, 40, 0);
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(false);
    expect(document.querySelector("[aria-hidden]")).toBeNull();
  });

  it("drags and drops while the button is held", () => {
    const { onStart, onEnd } = start();
    fire("pointermove", 1, 40, 0);
    fire("pointerup", 0, 40, 0);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(true, expect.objectContaining({ x: 40 }));
  });

  it("keeps the drop when late moves arrive after the button was released", () => {
    const { onEnd } = start();
    fire("pointermove", 1, 40, 0);
    fire("pointermove", 0, 60, 0);
    fire("pointerup", 0, 60, 0);
    expect(onEnd).toHaveBeenCalledWith(true, expect.objectContaining({ x: 60 }));
  });
});

const viewport = { left: 0, top: 0, right: 1280, bottom: 800 };

describe("dropZoneAt", () => {
  const rect = { left: 100, top: 100, width: 400, height: 200 };
  it("picks the nearest edge within its outer quarter, else the middle", () => {
    expect(dropZoneAt(300, 200, rect)).toBe("center");
    expect(dropZoneAt(110, 200, rect)).toBe("left");
    expect(dropZoneAt(490, 200, rect)).toBe("right");
    expect(dropZoneAt(300, 110, rect)).toBe("top");
    expect(dropZoneAt(300, 290, rect)).toBe("bottom");
  });
});

describe("isOutsideWindow", () => {
  it("treats the viewport interior as inside (issue #454: drag a tab out)", () => {
    expect(isOutsideWindow(viewport, 640, 400)).toBe(false);
    expect(isOutsideWindow(viewport, 0, 0)).toBe(false);
    expect(isOutsideWindow(viewport, 1279, 799)).toBe(false);
  });

  it("treats every side of the viewport as outside", () => {
    expect(isOutsideWindow(viewport, -1, 400)).toBe(true);
    expect(isOutsideWindow(viewport, 1280, 400)).toBe(true);
    expect(isOutsideWindow(viewport, 640, -1)).toBe(true);
    expect(isOutsideWindow(viewport, 640, 800)).toBe(true);
  });
});
