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
  // No layout either: CodeMirror measures text ranges when it positions the caret,
  // tooltips and line heights, sometimes in an animation frame after a test ends.
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.scrollTo ??= function () {} as Element["scrollTo"];

  // jsdom has no 2D canvas implementation; provide a minimal stub so libraries like
  // @excalidraw/excalidraw can probe canvas capabilities and measure text at import/test time.
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return {
        canvas: this,
        filter: "none",
        font: "16px sans-serif",
        fillStyle: "#000",
        strokeStyle: "#000",
        lineWidth: 1,
        save() {},
        restore() {},
        scale() {},
        rotate() {},
        translate() {},
        transform() {},
        setTransform() {},
        resetTransform() {},
        clearRect() {},
        fillRect() {},
        strokeRect() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        bezierCurveTo() {},
        quadraticCurveTo() {},
        arc() {},
        arcTo() {},
        rect() {},
        fill() {},
        stroke() {},
        clip() {},
        fillText() {},
        strokeText() {},
        drawImage() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        createPattern: () => null,
        getImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
        putImageData() {},
        setLineDash() {},
        getLineDash: () => [],
        measureText: (text: string) => ({
          width: text.length * 8,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
          fontBoundingBoxAscent: 14,
          fontBoundingBoxDescent: 4,
        }),
      } as unknown as RenderingContext;
    } as typeof HTMLCanvasElement.prototype.getContext;
  }
}
