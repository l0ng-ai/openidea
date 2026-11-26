import { afterEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  maximized: false,
  fullscreen: false,
  toggleMaximize: vi.fn(),
  toggleFullscreen: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => win.maximized,
    isFullscreen: async () => win.fullscreen,
    onResized: async () => () => {},
    toggleMaximize: win.toggleMaximize,
  }),
}));
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commands, type WindowButtonLayout } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { WindowControls } from "./WindowControls";
import { captionButtons } from "./windowButtons";

const initialPlatform = usePlatform.getState();
vi.spyOn(commands, "windowToggleFullscreen").mockImplementation(async () => {
  win.toggleFullscreen();
  return { status: "ok", data: false };
});
afterEach(() => {
  usePlatform.setState(initialPlatform);
  Object.assign(win, { maximized: false, fullscreen: false });
  win.toggleMaximize.mockClear();
  win.toggleFullscreen.mockClear();
});

const layouts = {
  default: { left: [], right: ["minimize", "maximize", "close"] },
  kdeLeft: { left: ["close", "maximize", "minimize"], right: [] },
  closeOnly: { left: [], right: ["close"] },
  split: { left: ["close"], right: ["minimize", "maximize"] },
  noClose: { left: ["minimize"], right: [] },
  empty: { left: [], right: [] },
} satisfies Record<string, WindowButtonLayout>;

describe("caption buttons per side", () => {
  it.each([
    ["default", [], ["minimize", "maximize", "close"]],
    ["kdeLeft", ["close", "maximize", "minimize"], []],
    ["closeOnly", [], ["close"]],
    ["split", ["close"], ["minimize", "maximize"]],
  ] as const)("%s window", (name, left, right) => {
    expect(captionButtons(layouts[name], "left")).toEqual(left);
    expect(captionButtons(layouts[name], "right")).toEqual(right);
  });

  it.each([
    ["default", "right"],
    ["kdeLeft", "left"],
    ["split", "left"],
    // Without close in the layout a dialog still needs one: on the side its buttons go.
    ["noClose", "left"],
    ["empty", "right"],
  ] as const)("%s dialog keeps close on the %s", (name, side) => {
    const layout = layouts[name];
    expect(captionButtons(layout, side, true)).toEqual(["close"]);
    expect(captionButtons(layout, side === "left" ? "right" : "left", true)).toEqual([]);
  });
});

describe("WindowControls", () => {
  const labels = () => screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label"));

  it("renders the left buttons in the desktop's order", () => {
    usePlatform.setState({ windowButtons: layouts.kdeLeft });
    const { container } = render(<WindowControls side="left" />);
    expect(labels()).toEqual(["Close", "Maximize", "Minimize"]);
    container.remove();
    render(<WindowControls side="right" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps today's right-hand buttons by default", () => {
    render(<WindowControls side="right" />);
    expect(labels()).toEqual(["Minimize", "Maximize", "Close"]);
  });

  it("leaves out buttons the layout omits", () => {
    usePlatform.setState({ windowButtons: layouts.closeOnly });
    render(<WindowControls side="right" />);
    expect(labels()).toEqual(["Close"]);
  });

  it("restores a full-screen window from the maximize button instead of maximizing it", async () => {
    win.fullscreen = true;
    render(<WindowControls side="right" />);
    await waitFor(() => expect(labels()).toEqual(["Minimize", "Restore Down", "Close"]));
    fireEvent.click(screen.getByRole("button", { name: "Restore Down" }));
    await waitFor(() => expect(win.toggleFullscreen).toHaveBeenCalledOnce());
    expect(win.toggleMaximize).not.toHaveBeenCalled();
  });

  it("toggles maximize outside full screen", async () => {
    render(<WindowControls side="right" />);
    // The button reads the window's state through a dynamic import first.
    await vi.dynamicImportSettled();
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    await waitFor(() => expect(win.toggleMaximize).toHaveBeenCalledOnce());
    expect(win.toggleFullscreen).not.toHaveBeenCalled();
  });
});
