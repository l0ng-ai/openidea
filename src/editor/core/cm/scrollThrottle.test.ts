import { afterEach, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { isScrollSettled, scrollThrottle } from "./scrollThrottle";
import { stickyScroll } from "./stickyScroll";

let view: EditorView | undefined;
type MeasureRequest = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;

afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function editor(extensions: Parameters<typeof EditorState.create>[0] = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  view = new EditorView({ state: EditorState.create(extensions), parent: document.body });
  return view;
}

describe("scroll throttle", () => {
  it("marks scrolling before previously installed bubble listeners run", () => {
    const seen: boolean[] = [];
    const listener = ViewPlugin.define((v) => {
      const onScroll = () => seen.push(v.dom.classList.contains("cm-scrolling"));
      v.scrollDOM.addEventListener("scroll", onScroll);
      return { destroy: () => v.scrollDOM.removeEventListener("scroll", onScroll) };
    });
    const v = editor({ extensions: [listener, scrollThrottle] });
    v.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(seen).toEqual([true]);
  });

  it("settles once after the last event in a burst", () => {
    const settled = vi.fn();
    const observer = EditorView.updateListener.of((u) => {
      if (isScrollSettled(u)) settled(u.view.dom.classList.contains("cm-scrolling"));
    });
    const v = editor({ extensions: [scrollThrottle, observer] });
    v.scrollDOM.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(100);
    v.scrollDOM.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(139);
    expect(v.dom.classList.contains("cm-scrolling")).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("removes its capture listener and pending timer when disabled", () => {
    const compartment = new Compartment();
    const settled = vi.fn();
    const v = editor({
      extensions: [
        compartment.of(scrollThrottle),
        EditorView.updateListener.of((u) => {
          if (isScrollSettled(u)) settled();
        }),
      ],
    });
    v.scrollDOM.dispatchEvent(new Event("scroll"));
    v.dispatch({ effects: compartment.reconfigure([]) });
    expect(v.dom.classList.contains("cm-scrolling")).toBe(false);
    v.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(v.dom.classList.contains("cm-scrolling")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(settled).not.toHaveBeenCalled();
  });

  it("defers sticky measurements from the first scroll event until settling", () => {
    const requests: MeasureRequest[] = [];
    const measure = vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation((request) => {
      if (request) requests.push(request);
    });
    // Match setup.ts: stickyScroll is installed before scrollThrottle.
    const v = editor({ extensions: [stickyScroll, scrollThrottle] });
    const initial = requests.shift()!;
    initial.write?.(initial.read(v), v);
    measure.mockClear();
    v.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(measure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(140);
    expect(requests).toHaveLength(1);
  });

  it("keeps painted sticky rows when a queued measurement meets a new burst", () => {
    const requests: MeasureRequest[] = [];
    vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation((request) => {
      if (request) requests.push(request);
    });
    const v = editor({ extensions: [stickyScroll, scrollThrottle] });
    const sticky = v.dom.querySelector<HTMLElement>(".cm-openidea-sticky")!;
    sticky.style.display = "";
    sticky.textContent = "previous header";
    const initial = requests.shift()!;
    const geometry = vi.spyOn(v.scrollDOM, "getBoundingClientRect");
    v.scrollDOM.dispatchEvent(new Event("scroll"));
    initial.write?.(initial.read(v), v);
    expect(geometry).not.toHaveBeenCalled();
    expect(sticky.textContent).toBe("previous header");
    expect(sticky.style.display).toBe("");
    vi.advanceTimersByTime(140);
    expect(requests).toHaveLength(1);
    const settled = requests.shift()!;
    settled.write?.(settled.read(v), v);
    expect(geometry).toHaveBeenCalled();
    expect(sticky.style.display).toBe("none");
  });
});
