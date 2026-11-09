/**
 * Skips DOM work for terminal rows whose markup did not change.
 *
 * xterm's DOM renderer rebuilds every dirty row with `replaceChildren`, even when the
 * new spans are identical. Full-screen TUIs (Grok, Claude Code, htop…) redraw the whole
 * screen for each spinner tick, so WebKitGTK restyles, lays out and paints every row
 * several times a second while only one or two actually changed; the window then falls
 * behind on keystrokes. Rows are still built (cheap); only identical ones are left in place.
 *
 * Remove once xterm's DomRenderer does this itself (xterm 6.0.0 does not).
 */
import type { Terminal } from "@xterm/xterm";

const MARKUP = Symbol("rowMarkup");

type RowElement = HTMLElement & { [MARKUP]?: string };

type BufferLine = unknown;

/** The parts of xterm 6's private DomRenderer this relies on. */
interface DomRenderer {
  _rowElements: RowElement[];
  _rowFactory: {
    createRow(
      line: BufferLine,
      row: number,
      isCursorRow: boolean,
      cursorStyle: unknown,
      cursorInactiveStyle: unknown,
      cursorX: number,
      cursorBlink: unknown,
      cellWidth: number,
      widthCache: unknown,
      linkStart: number,
      linkEnd: number,
    ): HTMLElement[];
  };
  _bufferService: {
    cols: number;
    buffer: { x: number; y: number; ybase: number; ydisp: number; lines: { get(i: number): BufferLine | undefined } };
  };
  _coreService: { decPrivateModes: { cursorBlink?: boolean; cursorStyle?: unknown } };
  _optionsService: { rawOptions: { cursorBlink?: boolean; cursorStyle?: unknown; cursorInactiveStyle?: unknown } };
  dimensions: { css: { cell: { width: number } } };
  _widthCache: unknown;
  renderRows(start: number, end: number): void;
  clear(): void;
  _setCellUnderline(...args: unknown[]): void;
}

const installed = new WeakSet<object>();

function forget(renderer: DomRenderer) {
  for (const row of renderer._rowElements) row[MARKUP] = undefined;
}

/** True when `proto` still looks like the xterm 6.0.0 renderer this was written against. */
function supported(proto: Partial<DomRenderer>): proto is DomRenderer {
  const { renderRows, clear, _setCellUnderline } = proto;
  if (typeof renderRows !== "function" || typeof clear !== "function" || typeof _setCellUnderline !== "function") {
    return false;
  }
  const source = Function.prototype.toString.call(renderRows);
  return source.includes("_rowFactory.createRow(") && source.includes("replaceChildren(");
}

/** Renders `start..end` like xterm's own `renderRows`, leaving unchanged rows alone. */
function renderRows(this: DomRenderer, start: number, end: number) {
  const buffer = this._bufferService.buffer;
  const cursorY = buffer.ybase + buffer.y;
  const cursorX = Math.min(buffer.x, this._bufferService.cols - 1);
  const modes = this._coreService.decPrivateModes;
  const options = this._optionsService.rawOptions;
  const cursorBlink = modes.cursorBlink ?? options.cursorBlink;
  const cursorStyle = modes.cursorStyle ?? options.cursorStyle;
  for (let y = start; y <= end; y++) {
    const row = y + buffer.ydisp;
    const element = this._rowElements[y];
    const line = buffer.lines.get(row);
    if (!element || !line) break;
    const spans = this._rowFactory.createRow(
      line,
      row,
      row === cursorY,
      cursorStyle,
      options.cursorInactiveStyle,
      cursorX,
      cursorBlink,
      this.dimensions.css.cell.width,
      this._widthCache,
      -1,
      -1,
    );
    let markup = "";
    for (const span of spans) markup += span.outerHTML;
    if (element[MARKUP] === markup) continue;
    element[MARKUP] = markup;
    element.replaceChildren(...spans);
  }
}

/**
 * Installs the row cache on the renderer `term` uses. Idempotent; a no-op for the WebGL
 * or canvas renderers, before `open()`, and on an xterm whose internals have changed.
 */
export function installDomRowCache(term: Terminal) {
  const renderer = (term as unknown as { _core?: { _renderService?: { _renderer?: { value?: object } } } })._core
    ?._renderService?._renderer?.value;
  if (!renderer) return;
  const proto = Object.getPrototypeOf(renderer) as Partial<DomRenderer>;
  if (installed.has(proto) || !supported(proto)) return;
  installed.add(proto);
  const { clear, _setCellUnderline } = proto;
  proto.renderRows = renderRows;
  // Both rebuild rows without going through renderRows.
  proto.clear = function (this: DomRenderer) {
    forget(this);
    clear.call(this);
  };
  proto._setCellUnderline = function (this: DomRenderer, ...args: unknown[]) {
    forget(this);
    _setCellUnderline.apply(this, args);
  };
}
