import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordShortcutDialog } from "../keymap/RecordShortcutDialog";

afterEach(cleanup);

const action = { id: "my.action", title: "My Action", category: "Test" };

describe("Mouse Shortcut dialog", () => {
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
});
