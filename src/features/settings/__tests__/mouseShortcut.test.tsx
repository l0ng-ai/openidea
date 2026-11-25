import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordShortcutDialog } from "../keymap/RecordShortcutDialog";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerAction } from "@/platform/actions";

afterEach(cleanup);
const originalPlatform = usePlatform.getState();
afterEach(() => usePlatform.setState(originalPlatform));
const originalSettings = useProject.getState().settings;
afterEach(() => useProject.setState({ settings: originalSettings }));

const action = { id: "my.action", title: "My Action", category: "Test" };
const rectangular = {
  id: "editor.createRectangularSelectionOnMouseDrag",
  title: "Create Rectangular Selection on Mouse Drag",
  category: "Editor Actions",
};

describe("Mouse Shortcut dialog", () => {
  it.each([
    [{ deltaY: -1, ctrlKey: true }, "Ctrl+Wheel Up", "Ctrl+WheelUp"],
    [{ deltaY: 1, shiftKey: true, altKey: true }, "Alt+Shift+Wheel Down", "Alt+Shift+WheelDown"],
    [{ deltaY: 1 }, "Wheel Down", "WheelDown"],
  ])("records and consumes %j as %s", (init, label, binding) => {
    usePlatform.setState({ os: "windows" });
    const onSubmit = vi.fn();
    render(
      <RecordShortcutDialog
        mouse
        action={action}
        actions={[action]}
        draft={{ preset: "intellij-windows", overrides: {} }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const pad = screen.getByRole("textbox", { name: "Mouse shortcut" });
    const wheel = new WheelEvent("wheel", { ...init, cancelable: true, bubbles: true });
    fireEvent(pad, wheel);
    expect(pad).toHaveTextContent(label);
    expect(wheel.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSubmit).toHaveBeenCalledWith(binding, [], false);
  });

  it("shows the assigned action and the enabled font zoom conflict without running either", () => {
    usePlatform.setState({ os: "macos" });
    useProject.setState({
      settings: { ...originalSettings, editor: { general: { wheelZoom: true } } } as typeof originalSettings,
    });
    const existing = { id: "my.otherAction", title: "Other Action" };
    const run = vi.fn();
    const unregister = registerAction({ ...existing, run });
    const originalKeymap = useKeymap.getState();
    const overrides = { [existing.id]: ["Meta+WheelDown"] };
    useKeymap.setState({ overrides });
    const uninstall = installKeyboardDispatcher(window);
    try {
      render(
        <RecordShortcutDialog
          mouse
          action={action}
          actions={[action, existing]}
          draft={{ preset: "intellij-macos", overrides }}
          onCancel={() => {}}
          onSubmit={() => {}}
        />,
      );
      const pad = screen.getByRole("textbox", { name: "Mouse shortcut" });
      fireEvent.wheel(pad, { deltaY: 1, metaKey: true });
      expect(pad).toHaveTextContent("⌘Wheel Down");
      expect(screen.getByText("Other Action")).toBeVisible();
      expect(screen.getByText(/takes precedence over.*font zoom/)).toBeVisible();
      expect(run).not.toHaveBeenCalled();
      fireEvent.wheel(pad, { deltaY: -1, altKey: true });
      expect(screen.queryByText(/takes precedence over.*font zoom/)).not.toBeInTheDocument();
      expect(screen.getByText("No conflicts")).toBeVisible();
    } finally {
      uninstall();
      unregister();
      useKeymap.setState(originalKeymap);
    }
  });

  it.each(["windows", "macos", "linux"] as const)("records middle drag and explains Linux paste on %s", (os) => {
    usePlatform.setState({ os });
    const onSubmit = vi.fn();
    render(
      <RecordShortcutDialog
        mouse
        action={rectangular}
        actions={[rectangular]}
        draft={{ preset: "intellij-windows", overrides: { [rectangular.id]: [] } }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("textbox", { name: "Mouse shortcut" }), { button: 1 });
    expect(screen.getByRole("textbox", { name: "Mouse shortcut" })).toHaveTextContent("Middle Click");
    expect(
      screen.queryByText("On Linux, middle-button rectangular selection conflicts with primary selection paste.") !==
        null,
    ).toBe(os === "linux");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSubmit).toHaveBeenCalledWith("Button2", [], false);
  });

  it.each([3, 4])("rejects side button %s for rectangular selection without replacing a valid gesture", (button) => {
    const onSubmit = vi.fn();
    render(
      <RecordShortcutDialog
        mouse
        action={rectangular}
        actions={[rectangular]}
        draft={{ preset: "intellij-windows", overrides: { [rectangular.id]: [] } }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const pad = screen.getByRole("textbox", { name: "Mouse shortcut" });
    fireEvent.mouseDown(pad, { button, altKey: true });
    fireEvent.wheel(pad, { deltaY: -1, ctrlKey: true });
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    expect(pad).toHaveTextContent("Click here with Ctrl, Alt or Command held, or use the middle mouse button");
    fireEvent.mouseDown(pad, { button: 0, altKey: true });
    expect(pad).toHaveTextContent("Left Click");
    fireEvent.mouseDown(pad, { button });
    expect(pad).toHaveTextContent("Left Click");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSubmit).toHaveBeenCalledWith("Alt+Button1", [], false);
  });

  it("records and submits Option+Command+left click", () => {
    const onSubmit = vi.fn();
    render(
      <RecordShortcutDialog
        mouse
        action={action}
        actions={[action]}
        draft={{ preset: "intellij-macos", overrides: {} }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("textbox", { name: "Mouse shortcut" }), {
      button: 0,
      altKey: true,
      metaKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSubmit).toHaveBeenCalledWith("Alt+Meta+Button1", [], false);
  });

  it("records a side-button click with modifiers and submits it", () => {
    const onSubmit = vi.fn();
    render(
      <RecordShortcutDialog
        mouse
        action={action}
        actions={[action]}
        draft={{ preset: "intellij-macos", overrides: {} }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const pad = screen.getByRole("textbox", { name: "Mouse shortcut" });
    fireEvent.mouseDown(pad, { button: 0 });
    fireEvent.wheel(pad, { deltaX: 16, deltaY: 1 });
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    fireEvent.mouseDown(pad, { button: 3, altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSubmit).toHaveBeenCalledWith("Alt+Button4", [], false);
  });
});

describe("Page swipe shortcut recording", () => {
  it.each(["SwipeLeft", "SwipeRight"])("records and submits %s from the focused recorder", (stroke) => {
    const onSubmit = vi.fn();
    render(
      <RecordShortcutDialog
        action={action}
        actions={[action]}
        draft={{ preset: "intellij-macos", overrides: {} }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    screen.getByRole("textbox", { name: "First stroke" }).focus();
    fireEvent(window, new CustomEvent("ide:page-swipe", { detail: stroke }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSubmit).toHaveBeenCalledWith(stroke, [], false);
  });
});
