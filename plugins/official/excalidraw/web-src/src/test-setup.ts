/**
 * jsdom has no canvas: Excalidraw probes a 2D context when it loads (and
 * measures text with it). A context whose methods do nothing is enough for
 * its data API.
 */
const context = new Proxy(
  { filter: "none", measureText: (text: string) => ({ width: text.length * 8 }) } as Record<string | symbol, unknown>,
  { get: (target, key) => (key in target ? target[key] : () => undefined) },
);
HTMLCanvasElement.prototype.getContext = (() => context) as unknown as HTMLCanvasElement["getContext"];
