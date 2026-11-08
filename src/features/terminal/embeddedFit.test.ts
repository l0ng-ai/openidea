import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmbeddedTerminal } from "./embedded";
import { FIT_SETTLE_MS, PROCESS_RESIZE_DELAY_MS } from "./fit";

const layout = vi.hoisted(() => ({ cols: 80, rows: 24, resize: () => {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    resized = (_size: { cols: number; rows: number }) => {};
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resized({ cols, rows });
    }
    onData() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    onResize(callback: typeof this.resized) {
      this.resized = callback;
      return { dispose() {} };
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: layout.cols, rows: layout.rows };
    }
  },
}));
vi.mock("./session", () => ({ fontFor: () => ({}), LINK_HANDLER: {}, openExternal: vi.fn(), openFileLink: vi.fn() }));
vi.mock("./theme", () => ({ readTerminalTheme: () => ({}), remeasureWhenFontsLoad: vi.fn(), MIN_CONTRAST_RATIO: 1 }));

beforeEach(() => {
  vi.useFakeTimers();
  layout.cols = 80;
  layout.rows = 24;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        layout.resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function terminal() {
  const host = document.createElement("div");
  Object.defineProperty(host, "offsetWidth", { value: 600 });
  Object.defineProperty(host, "offsetHeight", { value: 400 });
  document.body.append(host);
  const onResize = vi.fn();
  const term = createEmbeddedTerminal(host, { onData: vi.fn(), onResize });
  vi.advanceTimersByTime(FIT_SETTLE_MS + PROCESS_RESIZE_DELAY_MS);
  onResize.mockClear();
  return { term, onResize };
}

it.each([false, true])("reports only the final size after a drag, including unchanged final cells: %s", (sameCells) => {
  const { term, onResize } = terminal();
  try {
    layout.cols = 79;
    layout.resize();
    vi.advanceTimersToNextFrame();
    for (let i = 0; i < 40; i++) {
      if (!sameCells) layout.cols--;
      layout.resize();
      vi.advanceTimersByTime(16);
    }
    expect(onResize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIT_SETTLE_MS + PROCESS_RESIZE_DELAY_MS);
    expect(onResize).toHaveBeenCalledExactlyOnceWith(layout.cols, layout.rows);
    layout.resize();
    vi.advanceTimersByTime(FIT_SETTLE_MS + PROCESS_RESIZE_DELAY_MS);
    expect(onResize).toHaveBeenCalledOnce();
  } finally {
    term.dispose();
  }
});

it.each([false, true])("disposes with no pending fit or process resize timer: %s", (deferred) => {
  const { term, onResize } = terminal();
  layout.cols = 79;
  layout.resize();
  vi.advanceTimersToNextFrame();
  if (deferred) layout.resize();
  term.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(FIT_SETTLE_MS + PROCESS_RESIZE_DELAY_MS);
  expect(onResize).not.toHaveBeenCalled();
});
