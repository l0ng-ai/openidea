import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import type { Settings } from "@/platform/ipc";
import { useNativeTitlebar } from "./nativeTitlebar";

const { setHeight } = vi.hoisted(() => ({ setHeight: vi.fn().mockResolvedValue({ status: "ok" }) }));
vi.mock("@/platform/ipc", async (original) => {
  const ipc = await original<typeof import("@/platform/ipc")>();
  return { ...ipc, commands: { ...ipc.commands, windowSetTitlebarHeight: setHeight } };
});

const platform = usePlatform.getState();
const project = useProject.getState();
let resize: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  setHeight.mockClear();
  disconnect.mockClear();
  usePlatform.setState({ overlayTitleBar: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  usePlatform.setState(platform);
  useProject.setState(project);
  vi.unstubAllGlobals();
});

function zoom(percent: number) {
  useProject.setState({ settings: { appearance: { zoom: percent } } as Settings });
}

function titlebar(height: number) {
  const bar = document.createElement("header");
  const rect = vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, height));
  return { bar, rect };
}

describe("native title bar alignment", () => {
  it("keeps the native startup position until saved settings arrive", () => {
    useProject.setState({ settings: null });
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).not.toHaveBeenCalled();
    act(() => zoom(110));
    expect(setHeight).toHaveBeenCalledExactlyOnceWith(44);
  });

  it("does not resend the same height on resize notifications or effect remounts", () => {
    zoom(110);
    const { bar } = titlebar(40);
    const { rerender } = renderHook(({ bar }) => useNativeTitlebar(bar), { initialProps: { bar } });
    act(() => resize());
    rerender({ bar: titlebar(40).bar });
    act(() => resize());
    expect(setHeight).toHaveBeenCalledExactlyOnceWith(44);
  });

  it.each([50, 100, 125, 150, 200, 300])("converts CSS height to AppKit points at %s%%", (percent) => {
    zoom(percent);
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).toHaveBeenLastCalledWith((40 * percent) / 100);
  });

  it("uses the zoom the webview applies when the setting is out of range", () => {
    zoom(500);
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).toHaveBeenLastCalledWith(120);
  });

  it("updates when zoom or compact mode changes, and disconnects on unmount", () => {
    zoom(100);
    const { bar, rect } = titlebar(40);
    const { unmount } = renderHook(() => useNativeTitlebar(bar));
    act(() => zoom(150));
    expect(setHeight).toHaveBeenLastCalledWith(60);
    rect.mockReturnValue(new DOMRect(0, 0, 800, 32));
    act(() => resize());
    expect(setHeight).toHaveBeenLastCalledWith(48);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("leaves windows without native overlay buttons alone", () => {
    usePlatform.setState({ overlayTitleBar: false });
    const { bar } = titlebar(40);
    renderHook(() => useNativeTitlebar(bar));
    expect(setHeight).not.toHaveBeenCalled();
  });
});
