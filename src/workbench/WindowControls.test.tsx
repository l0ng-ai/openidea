import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isMaximized: async () => false, onResized: async () => () => {} }),
}));
import { render, screen } from "@testing-library/react";
import type { WindowButtonLayout } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { WindowControls } from "./WindowControls";
import { captionButtons } from "./windowButtons";

const initialPlatform = usePlatform.getState();
afterEach(() => usePlatform.setState(initialPlatform));

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
});
