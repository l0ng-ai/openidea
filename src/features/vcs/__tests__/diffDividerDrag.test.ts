import { describe, expect, it } from "vitest";
import type { MergeView } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { UnalignedPanes, DIFF_SPLIT_STORAGE_KEY } from "../diffScroll";

const doc = (s: string) => Text.of(s.split("\n"));

function panes(initialRatio = 50) {
  try {
    localStorage.removeItem(DIFF_SPLIT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  const root = document.createElement("div");
  const text = doc(Array.from({ length: 50 }, () => "line").join("\n"));
  const view = () => {
    const wrapper = root.appendChild(document.createElement("div"));
    const dom = wrapper.appendChild(document.createElement("div"));
    const scrollDOM = dom.appendChild(document.createElement("div"));
    Object.defineProperty(scrollDOM, "scrollHeight", { value: 1000 });
    return {
      dom,
      scrollDOM,
      state: { doc: text },
      get documentTop() {
        return -scrollDOM.scrollTop;
      },
      lineBlockAt: (pos: number) => ({ bottom: text.lineAt(pos).number * 20 }),
    } as unknown as EditorView;
  };
  const a = view();
  const b = view();
  const controller = new UnalignedPanes({ sync: true, initialRatio });
  controller.attach({ a, b, chunks: [] } as unknown as MergeView);
  const divider = root.querySelector(".cm-diffDivider") as HTMLElement;
  return { a, b, controller, divider };
}

const down = (el: HTMLElement, clientX: number) =>
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX }));
const move = (el: HTMLElement, clientX: number) =>
  el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX }));
const up = (el: HTMLElement) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));

describe("diff divider dragging (issue #2437)", () => {
  it("starts at an even split", () => {
    const p = panes();
    try {
      expect((p.a.dom.parentElement as HTMLElement).style.flex).toBe("50 1 0px");
      expect((p.b.dom.parentElement as HTMLElement).style.flex).toBe("50 1 0px");
    } finally {
      p.controller.destroy();
    }
  });

  it("drags the divider to resize the panes and persists the ratio", () => {
    const p = panes();
    try {
      down(p.divider, 100);
      // jsdom has no layout (total falls back to 1px), so a small move clamps to the 90% edge.
      move(p.divider, 100.6);
      expect((p.a.dom.parentElement as HTMLElement).style.flex).toBe("90 1 0px");
      expect((p.b.dom.parentElement as HTMLElement).style.flex).toBe("10 1 0px");
      up(p.divider);
      expect(localStorage.getItem(DIFF_SPLIT_STORAGE_KEY)).toBe("90");
    } finally {
      p.controller.destroy();
    }
  });

  it("ignores drags started on arrow buttons", () => {
    const p = panes();
    try {
      const btn = document.createElement("button");
      p.divider.appendChild(btn);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
      move(p.divider, 200);
      expect((p.a.dom.parentElement as HTMLElement).style.flex).toBe("50 1 0px");
    } finally {
      p.controller.destroy();
    }
  });

  it("nudges with arrow keys and resets on double-click", () => {
    const p = panes();
    try {
      p.divider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      expect((p.a.dom.parentElement as HTMLElement).style.flex).toBe("52 1 0px");
      p.divider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect((p.a.dom.parentElement as HTMLElement).style.flex).toBe("50 1 0px");
    } finally {
      p.controller.destroy();
    }
  });
});
