// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { ICON_SPAN_CLASS, installDomRowCache } from "./domRowCache";

/** Mirrors the shape of xterm 6's private DomRenderer closely enough for the cache. */
function fakeRendererClass() {
  return class FakeDomRenderer {
    lines: string[];
    _rowElements: HTMLElement[];
    underlines = 0;
    _bufferService = {
      cols: 10,
      buffer: { x: 0, y: 0, ybase: 0, ydisp: 0, lines: { get: (i: number) => this.lines[i] } },
    };
    _coreService = { decPrivateModes: {} };
    _optionsService = { rawOptions: { cursorBlink: false, cursorStyle: "block", cursorInactiveStyle: "outline" } };
    dimensions = { css: { cell: { width: 8 } } };
    _widthCache = {};
    _textBlinkStateManager = { isBlinkOn: true };
    /** Per row, as xterm 6.1 records it: rows that may blink while text blink is on. */
    blinkRows = new Map<number, boolean>();
    blinkUpdates = 0;
    _rowFactory = {
      defaultSpacing: 0,
      createRow: (line: string, _row: number, _cursor: boolean, ...rest: unknown[]) => {
        // The last argument is xterm 6.1's out-param: rows flagged here need blink tracking.
        const blink = rest.at(-1) as { hasBlinkingCells: boolean } | undefined;
        if (blink) blink.hasBlinkingCells = line.includes("BLINK");
        return line.split(" ").map((word) => {
          const span = document.createElement("span");
          const [text = "", spacing] = word.split("@");
          span.textContent = text;
          if (spacing) span.style.letterSpacing = spacing;
          return span;
        });
      },
    };

    constructor(lines: string[]) {
      this.lines = lines;
      this._rowElements = lines.map(() => document.createElement("div"));
    }

    renderRows(start: number, end: number) {
      const blink = { hasBlinkingCells: false };
      for (let y = start; y <= end; y++) {
        this._rowElements[y]?.replaceChildren(...this._rowFactory.createRow(this.lines[y] ?? "", y, false, blink));
        this._setRowBlinkState(y, blink.hasBlinkingCells);
      }
      this._updateTextBlinkState();
    }

    _setRowBlinkState(y: number, blinking: boolean) {
      this.blinkRows.set(y, blinking);
    }

    _updateTextBlinkState() {
      this.blinkUpdates++;
    }

    clear() {
      for (const row of this._rowElements) row.replaceChildren();
    }

    _setCellUnderline() {
      this.underlines++;
      for (const [y, row] of this._rowElements.entries()) {
        row.replaceChildren(
          ...this._rowFactory.createRow((this.lines[y] ?? "").toUpperCase(), y, false, { hasBlinkingCells: false }),
        );
      }
    }
  };
}

function rowAt(renderer: { _rowElements: HTMLElement[] }, y: number): HTMLElement {
  const row = renderer._rowElements[y];
  if (!row) throw new Error(`no row ${y}`);
  return row;
}

function terminalWith(renderer: object | undefined): Terminal {
  return { _core: { _renderService: { _renderer: { value: renderer } } } } as unknown as Terminal;
}

describe("installDomRowCache", () => {
  it("leaves unchanged rows in place and replaces changed ones", () => {
    const Renderer = fakeRendererClass();
    const renderer = new Renderer(["a b", "c d"]);
    installDomRowCache(terminalWith(renderer));

    renderer.renderRows(0, 1);
    const [first, second] = renderer._rowElements.map((row) => row.firstChild);
    renderer.lines[1] = "c e";
    renderer.renderRows(0, 1);

    expect(rowAt(renderer, 0).firstChild).toBe(first);
    expect(rowAt(renderer, 1).firstChild).not.toBe(second);
    expect(rowAt(renderer, 1).textContent).toBe("ce");
  });

  it("lifts spans with Nerd Font icons or wider-than-cell fallback glyphs over the next cell's background", () => {
    const Renderer = fakeRendererClass();
    // PUA icons (U+E606, U+F0035), non-PUA Nerd Font symbols (U+26A1), and fallback symbols
    // measured wider than one cell (U+23F2 with negative letter-spacing) lift; tiny subpixel
    // DPR rounding (-0.1px) and narrow glyphs (+1.2px) stay normal.
    const renderer = new Renderer(["\uE606 py \u{F0035} \u26A1 \u23F2@-2.4px a@-0.1px b@1.2px ~/src"]);
    installDomRowCache(terminalWith(renderer));
    renderer.renderRows(0, 0);
    const lifted = [...rowAt(renderer, 0).children].map((span) => span.classList.contains(ICON_SPAN_CLASS));
    expect(lifted).toEqual([true, false, true, true, true, false, false, false]);

    // Hovering a link (_setCellUnderline) rebuilds the row directly; overhanging spans stay lifted.
    renderer._setCellUnderline();
    const liftedOnHover = [...rowAt(renderer, 0).children].map((span) => span.classList.contains(ICON_SPAN_CLASS));
    expect(liftedOnHover).toEqual([true, false, true, true, true, false, false, false]);
  });

  it("keeps xterm's text-blink bookkeeping for rows it leaves in place", () => {
    const Renderer = fakeRendererClass();
    const renderer = new Renderer(["BLINK", "plain"]);
    installDomRowCache(terminalWith(renderer));

    renderer.renderRows(0, 1);
    const first = rowAt(renderer, 0).firstChild;
    renderer.renderRows(0, 1);

    expect(rowAt(renderer, 0).firstChild).toBe(first);
    expect([...renderer.blinkRows]).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(renderer.blinkUpdates).toBe(2);
  });

  it("re-renders rows after clear() and link underlines rebuilt them", () => {
    const Renderer = fakeRendererClass();
    const renderer = new Renderer(["a b"]);
    installDomRowCache(terminalWith(renderer));
    renderer.renderRows(0, 0);

    renderer.clear();
    renderer.renderRows(0, 0);
    expect(rowAt(renderer, 0).textContent).toBe("ab");

    renderer._setCellUnderline();
    expect(renderer.underlines).toBe(1);
    expect(rowAt(renderer, 0).textContent).toBe("AB");
    renderer.renderRows(0, 0);
    expect(rowAt(renderer, 0).textContent).toBe("ab");
  });

  it("installs once per renderer class", () => {
    const Renderer = fakeRendererClass();
    const a = new Renderer(["x"]);
    installDomRowCache(terminalWith(a));
    const patched = Renderer.prototype.renderRows;
    installDomRowCache(terminalWith(new Renderer(["y"])));

    expect(Renderer.prototype.renderRows).toBe(patched);
    a._setCellUnderline();
    expect(a.underlines).toBe(1);
  });

  it("does nothing before open() or when xterm's renderer no longer matches", () => {
    expect(() => installDomRowCache(terminalWith(undefined))).not.toThrow();

    class OtherRenderer {
      renderRows() {}
      clear() {}
      _setCellUnderline() {}
    }
    const original = OtherRenderer.prototype.renderRows;
    installDomRowCache(terminalWith(new OtherRenderer()));
    expect(OtherRenderer.prototype.renderRows).toBe(original);
  });
});
