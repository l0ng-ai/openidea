// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { installImeAnchor } from "./imeAnchor";

/** jsdom has no layout: the pieces the anchor reads report their own boxes. */
function rect(left: number, top: number, width = 8, height = 18): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

interface Fake {
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  term: Terminal;
  /** Runs every listener xterm's render and cursor-move events would fire. */
  tick(): void;
  /** Moves the terminal cursor, as the program's next frame would. */
  cursor(x: number, y: number): void;
}

function fake({
  cursorX = 0,
  cursorY = 0,
  cols = 80,
  rows = 20,
  showCursor = false,
  viewportY = 0,
  baseY = 0,
} = {}): Fake {
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  // 80 columns × 20 rows of 8 × 18 px cells.
  screen.getBoundingClientRect = () => rect(40, 40, 640, 360);
  const rowList = document.createElement("div");
  rowList.className = "xterm-rows";
  screen.append(rowList);
  const textarea = document.createElement("textarea");
  textarea.className = "xterm-helper-textarea";
  textarea.style.width = "8px";
  textarea.style.height = "18px";
  host.append(screen, textarea);
  const listeners: (() => void)[] = [];
  const active = { cursorX, cursorY, viewportY, baseY };
  const term = {
    textarea,
    cols,
    rows,
    buffer: { active },
    modes: { showCursor },
    onRender: (fn: () => void) => {
      listeners.push(fn);
      return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) };
    },
    onCursorMove: (fn: () => void) => {
      listeners.push(fn);
      return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) };
    },
  } as unknown as Terminal;
  return {
    host,
    textarea,
    term,
    tick: () => listeners.forEach((fn) => fn()),
    cursor: (x: number, y: number) => {
      active.cursorX = x;
      active.cursorY = y;
    },
  };
}

/** A reverse-video cell at `left`/`top`, on `row` of the rendered grid. */
function addCaret(f: Fake, left: number, top: number, row = 0) {
  const rowList = f.host.querySelector(".xterm-rows")!;
  while (rowList.children.length <= row) rowList.append(document.createElement("div"));
  const span = document.createElement("span");
  span.className = "xterm-bg-257";
  span.textContent = " ";
  span.getBoundingClientRect = () => rect(left, top);
  rowList.children[row]!.append(span);
}

/** Lets the `style` observer run, which is a microtask. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("installImeAnchor", () => {
  it("puts the IME anchor on the caret a program drew for itself", () => {
    const f = fake({ cursorX: 79, cursorY: 3 });
    // The caret cell sits 60px right of and 50px below the screen's origin.
    addCaret(f, 100, 90, 3);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("60px");
    expect(f.textarea.style.top).toBe("50px");
  });

  it("keeps the anchor inside the terminal, where the input method reads the caret", () => {
    const f = fake({ cursorX: 79 });
    addCaret(f, 100, 90);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    // A position outside the screen's box makes Windows put the candidate window in a corner.
    const left = Number.parseFloat(f.textarea.style.left);
    const top = Number.parseFloat(f.textarea.style.top);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(640);
    expect(top).toBeLessThan(360);
  });

  it("leaves xterm's own anchor alone while the cursor is inside the screen", () => {
    const f = fake({ cursorX: 12 });
    addCaret(f, 100, 90);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("");
    expect(f.textarea.style.top).toBe("");
  });

  it.each([
    ["the terminal cursor is visible", { showCursor: true }],
    ["the terminal is showing scrollback", { baseY: 30, viewportY: 15 }],
  ] as const)("ignores reverse video when %s", (_scenario, options) => {
    const f = fake({ cursorX: 79, ...options });
    addCaret(f, 100, 90);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("");
    expect(f.textarea.style.top).toBe("");
  });

  it("ignores xterm's own cursor cell and takes the program's caret", () => {
    const f = fake({ cursorX: 79 });
    // The terminal cursor's own cell: column 79 (screen origin 40,40; 8x18 cells).
    addCaret(f, 40 + 79 * 8, 40);
    // The caret the program drew.
    addCaret(f, 100, 90);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("60px");
  });
  it("still anchors when xterm clamps the cursor a cell or two short of the edge", () => {
    // Measured in pi: the clamped cursor ends up at cols-2 (and one past the row), never always
    // at the last cell.
    for (const cursorX of [78, 79, 80]) {
      const f = fake({ cursorX });
      addCaret(f, 100, 90);
      installImeAnchor({ host: f.host, term: f.term });

      f.tick();

      expect(f.textarea.style.left).toBe("60px");
    }
  });

  it("prefers the caret on the terminal cursor's row", () => {
    const f = fake({ cursorX: 79, cursorY: 5 });
    addCaret(f, 300, 40, 0); // some other reverse-video cell, e.g. a highlighted row
    addCaret(f, 100, 150, 5);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("60px");
    expect(f.textarea.style.top).toBe("110px");
  });

  it("takes a single caret from another row when the program's cursor drifted", () => {
    // pi scrolls its input box but keeps asking for the last column of the row its hardware cursor
    // landed on, three rows below the caret: the only reverse-video cell is still the caret.
    const f = fake({ cursorX: 79, cursorY: 27 });
    addCaret(f, 100, 90, 24);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("60px");
    expect(f.textarea.style.top).toBe("50px");
  });

  it("gives up when the cells elsewhere are not the cursor and there is more than one", () => {
    const f = fake({ cursorX: 79, cursorY: 5 });
    addCaret(f, 100, 40, 0);
    addCaret(f, 300, 40, 1);
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("");
  });

  it("leaves xterm's own anchor alone when two cells are not the cursor", () => {
    const f = fake({ cursorX: 79 });
    addCaret(f, 100, 90);
    addCaret(f, 300, 90); // a selection or a highlighted row, not a caret
    installImeAnchor({ host: f.host, term: f.term });

    f.tick();

    expect(f.textarea.style.left).toBe("");
  });

  it("puts the anchor back when xterm re-places it on the cursor", async () => {
    const f = fake({ cursorX: 79 });
    addCaret(f, 100, 90);
    installImeAnchor({ host: f.host, term: f.term });
    f.tick();

    // What xterm's composition helper writes on `compositionstart` and every update.
    f.textarea.style.left = "616.8px";
    f.textarea.style.top = "0px";
    await settle();

    expect(f.textarea.style.left).toBe("60px");
    expect(f.textarea.style.top).toBe("50px");
  });

  it("keeps the caret offset through a frame that misses it", async () => {
    const f = fake({ cursorX: 79 });
    addCaret(f, 100, 90);
    installImeAnchor({ host: f.host, term: f.term });
    f.tick();
    expect(f.textarea.style.left).toBe("60px");

    // The program redraws without its caret for a moment: the composition opening now must not
    // fall back to the far end of the row.
    f.host.querySelector(".xterm-rows")!.replaceChildren();
    f.tick();
    await settle();

    expect(f.textarea.style.left).toBe("60px");
    expect(f.textarea.style.top).toBe("50px");
  });

  it("hands the position back to xterm when the cursor leaves the last column", async () => {
    const f = fake({ cursorX: 79 });
    addCaret(f, 100, 90);
    installImeAnchor({ host: f.host, term: f.term });
    f.tick();
    expect(f.textarea.style.left).toBe("60px");

    // A program that puts its hardware cursor on the caret needs no anchor at all.
    f.cursor(12, 0);
    f.tick();
    await settle();

    expect(f.textarea.style.left).toBe("96px");
    expect(f.textarea.style.top).toBe("0px");
  });

  it("moves the composition view too, and stops once disposed", async () => {
    const f = fake({ cursorX: 79 });
    addCaret(f, 100, 90);
    const view = document.createElement("div");
    view.className = "composition-view";
    f.host.querySelector(".xterm-screen")!.append(view);
    const dispose = installImeAnchor({ host: f.host, term: f.term });

    f.tick();
    expect(view.style.left).toBe("60px");
    expect(view.hasAttribute("data-openidea-ime-anchor")).toBe(true);

    dispose();
    expect(view.style.left).toBe("632px");
    expect(view.hasAttribute("data-openidea-ime-anchor")).toBe(false);
    // xterm owns the position again: nothing moves it away any more.
    f.textarea.style.left = "640px";
    await settle();
    expect(f.textarea.style.left).toBe("640px");
  });
});
