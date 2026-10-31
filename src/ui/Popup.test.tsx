import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { getContext, setContext } from "@/platform/context";
import { registerAction } from "@/platform/actions";
import { Popup } from "./Popup";
import { ContextMenuHost, Menu, MenuList, hideContextMenu, showContextMenu } from "./Menu";
import { Dialog } from "./Dialog";

function Harness({ onClose }: { onClose?: (r: string) => void }) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref}>anchor</button>
      <button>outside</button>
      <Popup
        open={open}
        anchor={ref}
        aria-label="Test popup"
        onClose={(r) => {
          onClose?.(r);
          setOpen(false);
        }}
      >
        <button>inside</button>
      </Popup>
    </>
  );
}

describe("Popup", () => {
  it("closes on Escape, publishes popupOpen and restores focus", () => {
    const onClose = vi.fn();
    const anchorFocus = document.createElement("button");
    document.body.appendChild(anchorFocus);
    anchorFocus.focus();
    render(<Harness onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Test popup" })).toBeInTheDocument();
    expect(getContext().popupOpen).toBe(true);
    expect(document.activeElement).toBe(screen.getByText("inside"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getContext().popupOpen).toBe(false);
    expect(document.activeElement).toBe(anchorFocus);
    anchorFocus.remove();
  });

  it("closes on outside pointer down but not inside or on the anchor", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText("inside"));
    fireEvent.pointerDown(screen.getByText("anchor"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(onClose).toHaveBeenCalledWith("outside");
  });

  it("closes when the app window is deactivated, but not when focus moves into a frame", () => {
    vi.useFakeTimers();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      const onClose = vi.fn();
      render(<Harness onClose={onClose} />);
      fireEvent.blur(window);
      act(() => void vi.runAllTimers());
      expect(onClose).not.toHaveBeenCalled();
      hasFocus.mockReturnValue(false);
      fireEvent.blur(window);
      act(() => void vi.runAllTimers());
      expect(onClose).toHaveBeenCalledWith("outside");
    } finally {
      hasFocus.mockRestore();
      vi.useRealTimers();
    }
  });

  it("only the top-most layer handles Escape", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const ui = (withPopup: boolean) => (
      <Dialog open onClose={outer} title="Outer">
        <Popup open={withPopup} anchor={{ x: 0, y: 0 }} onClose={inner} aria-label="Inner">
          <button>x</button>
        </Popup>
      </Dialog>
    );
    const { rerender } = render(ui(false));
    rerender(ui(true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("Menu", () => {
  it("navigates with arrows, skips disabled items, runs actions and closes", async () => {
    const run = vi.fn();
    const actionRun = vi.fn();
    const dispose = registerAction({ id: "test.menuAction", title: "From Action", run: actionRun });
    const onClose = vi.fn();
    render(
      <Menu
        open
        onClose={onClose}
        anchor={{ x: 0, y: 0 }}
        items={[
          { label: "First", run },
          { label: "Disabled", disabled: true },
          { kind: "separator" },
          { kind: "action", action: "test.menuAction" },
          { kind: "action", action: "missing.action" },
        ]}
      />,
    );
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["First", "Disabled", "From Action"]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    await act(async () => {
      fireEvent.keyDown(items[2]!, { key: "Enter" });
    });
    expect(onClose).toHaveBeenCalled();
    expect(actionRun).toHaveBeenCalled();
    dispose();
  });
});

describe("Dialog deactivation", () => {
  it("closes popups but not modal dialogs when the app window loses focus", () => {
    vi.useFakeTimers();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      const popup = vi.fn();
      const modal = vi.fn();
      render(
        <>
          <Dialog open onClose={modal} title="Modal">
            <p>body</p>
          </Dialog>
          <Dialog open onClose={popup} position="top" aria-label="Popup">
            <p>body</p>
          </Dialog>
        </>,
      );
      fireEvent.blur(window);
      act(() => void vi.runAllTimers());
      expect(popup).toHaveBeenCalledTimes(1);
      expect(modal).not.toHaveBeenCalled();
    } finally {
      hasFocus.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("Dialog initial focus", () => {
  it("focuses the first control of the content, not the header close button", () => {
    render(
      <Dialog open onClose={() => {}} title="Configs" footer={<button>OK</button>}>
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("falls back to the footer when the content has no controls", () => {
    render(
      <Dialog open onClose={() => {}} title="Info" footer={<button>OK</button>}>
        <p>Nothing to edit</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByText("OK"));
  });
});

describe("Menu action enablement", () => {
  it("returns focus to the element focused before a context menu opened", () => {
    render(
      <>
        <textarea aria-label="input" />
        <ContextMenuHost />
      </>,
    );
    const input = screen.getByRole("textbox", { name: "input" });
    input.focus();
    act(() => showContextMenu({ x: 0, y: 0 }, [{ label: "Paste", run: () => undefined }]));
    expect(screen.getByRole("menuitem", { name: /Paste/ })).toHaveFocus();
    act(() => hideContextMenu());
    expect(input).toHaveFocus();
  });

  it("follows context changes after the menu opened", () => {
    const dispose = registerAction({ id: "test.menuWhen", title: "Needs Flag", when: "qaMenuFlag", run: () => {} });
    setContext("qaMenuFlag", false);
    render(<MenuList items={[{ kind: "action", action: "test.menuWhen" }]} onDone={() => {}} />);
    expect(screen.getByRole("menuitem", { name: /Needs Flag/ })).toHaveAttribute("aria-disabled", "true");
    act(() => setContext("qaMenuFlag", true));
    expect(screen.getByRole("menuitem", { name: /Needs Flag/ })).not.toHaveAttribute("aria-disabled", "true");
    dispose();
  });
});
