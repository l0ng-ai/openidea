import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { registerStatusItem } from "./contributions";
import { overflowingStatusItems, StatusBar, type MeasuredStatusItem } from "./StatusBar";

const m = (id: string, priority: number, width: number): MeasuredStatusItem => ({ id, priority, width });

// The bar at the 400 px minimum window width (#4071): right items in the default IDE.
const ide = [
  m("workbench.tasks", 0, 0),
  m("code-insight.servers", 5, 110),
  m("editor.caret", 20, 32),
  m("editor.lineEnding", 30, 24),
  m("editor.encoding", 40, 46),
  m("editor.indent", 50, 64),
  m("python.interpreter", 90, 116),
];

describe("overflowingStatusItems", () => {
  const cases: [string, MeasuredStatusItem[], number, string[]][] = [
    ["everything fits exactly", [m("a", 1, 50), m("b", 2, 50)], 108, []],
    ["one px short moves the lowest priority out", [m("a", 1, 50), m("b", 2, 50)], 107, ["a"]],
    ["the overflow button's room can push out one more", [m("a", 1, 20), m("b", 2, 20), m("c", 3, 50)], 90, ["a", "b"]],
    ["priority decides, not bar position", [m("hi", 9, 40), m("lo", 1, 40), m("mid", 5, 40)], 100, ["lo", "mid"]],
    ["equal priorities go in bar order", [m("a", 1, 40), m("b", 1, 40), m("c", 1, 40)], 100, ["a", "b"]],
    ["empty items take no room and never overflow", [m("empty", 0, 0), m("a", 1, 50), m("b", 2, 50)], 108, []],
    ["too narrow for any item", [m("a", 1, 50), m("b", 2, 50)], 40, ["a", "b"]],
    [
      "#4071: the interpreter stays at 400 px",
      ide,
      250,
      ["code-insight.servers", "editor.caret", "editor.lineEnding", "editor.encoding"],
    ],
    ["#4071: a wide window shows everything", ide, 1000, []],
  ];
  it.each(cases)("%s", (_, items, available, out) => {
    expect([...overflowingStatusItems(items, available, 4, 24)]).toEqual(out);
  });

  it("follows an item whose width changes", () => {
    const at = (caret: number) => [...overflowingStatusItems([m("caret", 1, caret), m("enc", 2, 50)], 100, 4, 24)];
    expect(at(30)).toEqual([]);
    expect(at(60)).toEqual(["caret"]);
    expect(at(30)).toEqual([]);
  });
});

describe("status bar overflow", () => {
  let width = 400;
  const widths: Record<string, number> = { caret: 100, encoding: 150, interpreter: 200 };
  let resize = () => {};
  let observed = false;
  afterEach(() => vi.restoreAllMocks());

  it("moves what doesn't fit into a popup without remounting it, and back when wider", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        // The bar's observer comes first; popups position themselves with their own.
        constructor(cb: () => void) {
          if (!observed) resize = cb;
          observed = true;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { width: widths[this.dataset.statusItem ?? ""] ?? 0 } as DOMRect;
    });
    const mounts: Record<string, number> = {};
    const clicks = vi.fn();
    const widget = (id: string, priority: number) => ({
      id,
      align: "right" as const,
      priority,
      title: id,
      component: function Widget() {
        useEffect(() => {
          mounts[id] = (mounts[id] ?? 0) + 1;
        }, []);
        return <button onClick={() => clicks(id)}>{id} widget</button>;
      },
    });
    const disposers = [widget("caret", 20), widget("encoding", 40), widget("interpreter", 90)].map(registerStatusItem);
    render(<StatusBar />);
    act(() => resize());

    // 450 px of items in 400: the lowest priority goes first.
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    const popup = screen.getByRole("dialog", { name: "Show more" });
    expect(popup.textContent).toContain("caret widget");
    expect(popup.textContent).not.toContain("interpreter widget");
    fireEvent.click(screen.getByRole("button", { name: "caret widget" }));
    expect(clicks).toHaveBeenCalledWith("caret");

    width = 1000;
    act(() => resize());
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const ids = [...document.querySelectorAll("footer [data-status-item]")].map((el) =>
      el.getAttribute("data-status-item"),
    );
    expect(ids).toEqual(["caret", "encoding", "interpreter"]);
    expect(mounts).toEqual({ caret: 1, encoding: 1, interpreter: 1 });
    disposers.forEach((d) => d());
    vi.unstubAllGlobals();
  });
});
