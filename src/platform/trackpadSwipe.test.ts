import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "./actions";
import { useKeymap } from "./keymap";
import { captureSwipes, installSwipeDispatch, isNativeSwipe, routeSwipe, SWIPE_EVENT } from "./trackpadSwipe";

const listen = vi.hoisted(() => vi.fn());
const tauri = vi.hoisted(() => ({ value: true }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen }) }));
vi.mock("./ipc", () => ({ isTauri: () => tauri.value }));

const payload = { direction: "right", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("native swipe payload", () => {
  it("accepts the event the backend emits", () => {
    expect(isNativeSwipe(payload)).toBe(true);
    expect(isNativeSwipe({ ...payload, direction: "left", altKey: true })).toBe(true);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "right"],
    ["an unknown direction", { ...payload, direction: "up" }],
    ["a missing modifier", { direction: "left", metaKey: false, ctrlKey: false, altKey: false }],
    ["a non-boolean modifier", { ...payload, shiftKey: "no" }],
  ])("rejects %s", (_, value) => {
    expect(isNativeSwipe(value)).toBe(false);
  });
});

describe("routing a swipe", () => {
  const back = vi.fn();
  let remove: () => void;

  beforeEach(() => {
    back.mockReset();
    remove = registerAction({ id: "navigate.back", title: "Back", run: back });
    useKeymap.setState({ preset: "intellij-macos", overrides: {} });
  });
  afterEach(() => remove());

  it("runs the bound action", async () => {
    expect(routeSwipe(payload)).toBe(true);
    await Promise.resolve();
    expect(back).toHaveBeenCalledOnce();
  });

  it("ignores a malformed payload", () => {
    expect(routeSwipe({ direction: "sideways" })).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it("hands the stroke to an open recorder instead of running the action", async () => {
    const seen: string[] = [];
    const stop = captureSwipes((stroke) => seen.push(stroke));
    try {
      expect(routeSwipe({ ...payload, altKey: true })).toBe(true);
      await Promise.resolve();
      expect(seen).toEqual(["Alt+SwipeRight"]);
      expect(back).not.toHaveBeenCalled();
    } finally {
      stop();
    }
    expect(routeSwipe(payload)).toBe(true);
    await Promise.resolve();
    expect(back).toHaveBeenCalledOnce();
  });

  it("gives the newest recorder the swipe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = captureSwipes(first);
    const stopSecond = captureSwipes(second);
    try {
      routeSwipe(payload);
      expect(second).toHaveBeenCalledWith("SwipeRight");
      expect(first).not.toHaveBeenCalled();
    } finally {
      stopSecond();
    }
    routeSwipe(payload);
    expect(first).toHaveBeenCalledWith("SwipeRight");
    stopFirst();
  });
});

describe("installing the listener", () => {
  beforeEach(() => {
    listen.mockReset();
    tauri.value = true;
  });

  it("listens on this window only and routes what arrives", async () => {
    const off = vi.fn();
    let handler: (e: { payload: unknown }) => void = () => {};
    listen.mockImplementation(async (name: string, cb: typeof handler) => {
      expect(name).toBe(SWIPE_EVENT);
      handler = cb;
      return off;
    });
    const run = vi.fn();
    const remove = registerAction({ id: "navigate.back", title: "Back", run });
    useKeymap.setState({ preset: "intellij-macos", overrides: {} });
    const dispose = installSwipeDispatch();
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    handler({ payload });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    dispose();
    await vi.waitFor(() => expect(off).toHaveBeenCalledOnce());
    remove();
  });

  it("releases the listener when disposed before it finished registering", async () => {
    const off = vi.fn();
    listen.mockImplementation(async () => off);
    installSwipeDispatch()();
    await vi.waitFor(() => expect(off).toHaveBeenCalledOnce());
  });

  it("does nothing outside the desktop app", () => {
    tauri.value = false;
    installSwipeDispatch()();
    expect(listen).not.toHaveBeenCalled();
  });
});
