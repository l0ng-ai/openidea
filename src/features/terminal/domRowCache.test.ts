// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { installDomRowCache } from "./domRowCache";

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
    _rowFactory = {
      createRow: (line: string) =>
        line.split(" ").map((word) => {
          const span = document.createElement("span");
          span.textContent = word;
          return span;
        }),
    };

    constructor(lines: string[]) {
      this.lines = lines;
      this._rowElements = lines.map(() => document.createElement("div"));
    }

    renderRows(start: number, end: number) {
      for (let y = start; y <= end; y++) {
        this._rowElements[y]?.replaceChildren(...this._rowFactory.createRow(this.lines[y] ?? ""));
      }
    }

    clear() {
      for (const row of this._rowElements) row.replaceChildren();
    }

    _setCellUnderline() {
      this.underlines++;
      for (const [y, row] of this._rowElements.entries()) {
        row.replaceChildren(...this._rowFactory.createRow((this.lines[y] ?? "").toUpperCase()));
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
