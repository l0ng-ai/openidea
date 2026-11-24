import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// jsdom has no layout: give elements a size so virtualized lists render rows.
if (typeof window !== "undefined") {
  // jsdom's user agent names the host OS; tests are written for macOS (⌘ keymaps) and opt into Windows explicitly.
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) jsdom",
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 400 });

  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  }
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  Element.prototype.scrollIntoView ??= function () {};
  // xterm 6.1 measures glyph widths on a 2D canvas; jsdom has none, and its renderer
  // throws without a context. Every glyph counts as one 8px cell, which is all the
  // tests read (they assert markup and classes, not pixels).
  const context2d = {
    font: "",
    fillRect() {},
    fillText() {},
    measureText: (text: string) => ({
      width: text.length * 8,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
    }),
  } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
    contextId === "2d" ? context2d : null) as HTMLCanvasElement["getContext"];
  // No layout either: CodeMirror measures text ranges when it positions the caret,
  // tooltips and line heights, sometimes in an animation frame after a test ends.
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.scrollTo ??= function () {} as Element["scrollTo"];
  if (!("Highlight" in globalThis)) {
    class HighlightStub extends Set<AbstractRange> {
      priority = 0;
    }
    (globalThis as unknown as { Highlight: unknown }).Highlight = HighlightStub;
  }
  const gCss = ((globalThis as unknown as { CSS?: Record<string, unknown> }).CSS ??= {});
  gCss.highlights ??= new Map<string, Set<AbstractRange>>();
}
