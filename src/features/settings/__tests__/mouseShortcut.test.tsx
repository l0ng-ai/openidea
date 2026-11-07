import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { usePlatform } from "@/platform/platformInfo";
import { routeSwipe } from "@/platform/trackpadSwipe";
import { RecordShortcutDialog } from "../keymap/RecordShortcutDialog";

afterEach(cleanup);

const action = { id: "my.action", title: "My Action", category: "Test" };

describe("Mouse Shortcut dialog", () => {
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
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    fireEvent.mouseDown(pad, { button: 3, altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSubmit).toHaveBeenCalledWith("Alt+Button4", [], false);
  });

  describe("trackpad swipes", () => {
    const swipe = { direction: "right", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    const back = { id: "navigate.back", title: "Back", category: "Navigate" };
    const renderDialog = (onSubmit = vi.fn()) => {
      render(
        <RecordShortcutDialog
          mouse
          action={action}
          actions={[action, back]}
          draft={{ preset: "intellij-macos", overrides: {} }}
          onCancel={() => {}}
          onSubmit={onSubmit}
        />,
      );
      return onSubmit;
    };

    afterEach(() => usePlatform.setState({ os: "macos" }));

    it("records a swipe on macOS and submits it", () => {
      usePlatform.setState({ os: "macos" });
      const onSubmit = renderDialog();
      act(() => void routeSwipe({ ...swipe, altKey: true }));
      expect(screen.getByRole("textbox", { name: "Mouse shortcut" })).toHaveTextContent("⌥Swipe Right");
      fireEvent.click(screen.getByRole("button", { name: "OK" }));
      expect(onSubmit).toHaveBeenCalledWith("Alt+SwipeRight", [], false);
    });

    it("lists the actions a recorded swipe would take over", () => {
      usePlatform.setState({ os: "macos" });
      renderDialog();
      act(() => void routeSwipe(swipe));
      expect(screen.getByText(/Back/)).toBeInTheDocument();
    });

    it("does not listen for swipes elsewhere, and does not offer them", () => {
      usePlatform.setState({ os: "windows" });
      renderDialog();
      act(() => void routeSwipe(swipe));
      expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
      expect(screen.getByRole("textbox", { name: "Mouse shortcut" })).not.toHaveTextContent(/swipe/i);
    });
  });
});
