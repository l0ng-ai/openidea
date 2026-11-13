import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { getContext, setContext } from "@/platform/context";
import { registerAction } from "@/platform/actions";
import { Popup } from "./Popup";
import { ContextMenuHost, Menu, MenuList, hideContextMenu, showContextMenu, useContextMenuStore } from "./Menu";
import menuStyles from "./Menu.module.css";
import popupStyles from "./Popup.module.css";
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

  it("resizes by its right edge, bottom edge and corner within the minimums, and reports each size", () => {
    const onResized = vi.fn();
    render(
      <Popup
        open
        anchor={{ x: 0, y: 0 }}
        onClose={() => {}}
        aria-label="Branches"
        resizable="both"
        minWidth={200}
        minHeight={100}
        initialSize={{ w: 400, h: 300 }}
        onResized={onResized}
      >
        <div>rows</div>
      </Popup>,
    );
    const popup = screen.getByRole("dialog", { name: "Branches" });
    expect([popup.style.width, popup.style.height]).toEqual(["400px", "300px"]);
    // jsdom lays nothing out: the popup measures what its style says, at the origin.
    popup.getBoundingClientRect = () =>
      new DOMRect(0, 0, parseFloat(popup.style.width), parseFloat(popup.style.height));
    const drag = (handle: Element, dx: number, dy: number) => {
      fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { buttons: 1, clientX: dx, clientY: dy });
      fireEvent.pointerUp(window);
      return [popup.style.width, popup.style.height];
    };
    expect(drag(popup.querySelector(`.${popupStyles.resizeRight}`)!, 100, 50)).toEqual(["500px", "300px"]);
    expect(drag(popup.querySelector(`.${popupStyles.resizeBottom}`)!, 50, -100)).toEqual(["500px", "200px"]);
    expect(drag(screen.getByRole("separator", { name: "Resize" }), -1000, -1000)).toEqual(["200px", "100px"]);
    expect(onResized.mock.calls).toEqual([[{ w: 500, h: 300 }], [{ w: 500, h: 200 }], [{ w: 200, h: 100 }]]);
  });

  it("has no resize handles and ignores a remembered size unless resizable", () => {
    render(
      <Popup open anchor={{ x: 0, y: 0 }} onClose={() => {}} aria-label="Menu" initialSize={{ w: 400, h: 300 }}>
        <div>rows</div>
      </Popup>,
    );
    expect(screen.getByRole("dialog", { name: "Menu" }).style.width).toBe("");
    expect(screen.queryByRole("separator", { name: "Resize" })).toBeNull();
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

  it("keeps the text selection a context menu was opened on", async () => {
    render(
      <>
        <p>Selected text</p>
        <ContextMenuHost />
      </>,
    );
    // WebKit drops the page's selection whenever focus moves.
    const drop = () => document.getSelection()!.removeAllRanges();
    document.addEventListener("focusin", drop);
    try {
      const text = screen.getByText("Selected text").firstChild!;
      document.getSelection()!.setBaseAndExtent(text, 0, text, 8);
      act(() => showContextMenu({ x: 0, y: 0 }, [{ label: "Copy", run: () => undefined }]));
      expect(screen.getByRole("menuitem", { name: /Copy/ })).toHaveFocus();
      expect(document.getSelection()!.toString()).toBe("Selected");
      act(() => hideContextMenu());
      await act(async () => {});
      expect(document.getSelection()!.toString()).toBe("Selected");
    } finally {
      document.removeEventListener("focusin", drop);
      document.getSelection()!.removeAllRanges();
    }
  });

  it("highlights the row under the pointer without moving focus", () => {
    render(
      <MenuList
        items={[
          { label: "Open", run: () => undefined },
          { label: "Save", run: () => undefined },
        ]}
        onDone={() => {}}
      />,
    );
    const open = screen.getByRole("menuitem", { name: "Open" });
    const save = screen.getByRole("menuitem", { name: "Save" });
    expect(open).toHaveFocus();
    expect(open.className).toContain(menuStyles.active);
    fireEvent.pointerEnter(save);
    expect(save.className).toContain(menuStyles.active);
    expect(open.className).not.toContain(menuStyles.active);
    expect(open).toHaveFocus();
  });

  it("reports a hovered row once and lets the keyboard continue from it", () => {
    const active: string[] = [];
    const item = (label: string) => ({ label, onActive: () => active.push(label), run: () => undefined });
    render(<MenuList items={[item("Open"), item("Save"), item("Close")]} onDone={() => {}} />);
    const save = screen.getByRole("menuitem", { name: "Save" });
    fireEvent.pointerEnter(save);
    fireEvent.mouseEnter(save);
    expect(active).toEqual(["Save"]);
    fireEvent.keyDown(save, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Close" })).toHaveFocus();
    fireEvent.pointerLeave(save);
    fireEvent.pointerEnter(save);
    expect(active).toEqual(["Save", "Close", "Save"]);
  });

  it.each(["enter submenu", "enter padding", "stop", "move away", "switch submenu", "unmount"])(
    "protects a diagonal submenu path until the pointer chooses to %s",
    (choice) => {
      vi.useFakeTimers();
      try {
        const onActive = vi.fn();
        const { unmount } = render(
          <MenuList
            items={[
              { label: "Parent", submenu: [{ label: "Child" }] },
              {
                label: "Sibling",
                onActive,
                submenu: choice === "switch submenu" ? [{ label: "Other child" }] : undefined,
              },
            ]}
            onDone={() => {}}
          />,
        );
        const parent = screen.getByRole("menuitem", { name: "Parent" });
        const sibling = screen.getByRole("menuitem", { name: "Sibling" });
        fireEvent.pointerEnter(parent, { clientX: 40, clientY: 20 });
        act(() => vi.advanceTimersByTime(120));
        const child = screen.getByRole("menuitem", { name: "Child" });
        vi.spyOn(child.closest("[data-popup]")!, "getBoundingClientRect").mockReturnValue({
          left: 182,
          right: 362,
          top: 6,
          bottom: 150,
          width: 180,
          height: 144,
          x: 182,
          y: 6,
          toJSON: () => ({}),
        });
        fireEvent.pointerMove(parent, { clientX: 50, clientY: 20 });
        fireEvent.pointerLeave(parent);
        fireEvent.pointerEnter(sibling, { clientX: 70.5, clientY: 35.5 });
        fireEvent.mouseLeave(parent);
        fireEvent.mouseEnter(sibling, { clientX: 70, clientY: 35 });
        act(() => vi.advanceTimersByTime(250));
        expect(parent).toHaveClass(menuStyles.active!);
        expect(parent).toHaveAttribute("aria-expanded", "true");
        expect(onActive).not.toHaveBeenCalled();
        fireEvent.pointerMove(sibling, { clientX: 100, clientY: 45 });
        act(() => vi.advanceTimersByTime(250));
        expect(parent).toHaveAttribute("aria-expanded", "true");

        if (choice === "unmount") {
          unmount();
          act(() => vi.advanceTimersByTime(500));
          expect(onActive).not.toHaveBeenCalled();
        } else if (choice === "enter submenu" || choice === "enter padding") {
          fireEvent.pointerLeave(sibling);
          fireEvent.pointerMove(document.body, { clientX: 181, clientY: 65 });
          if (choice === "enter padding") {
            fireEvent.pointerMove(child.closest("[data-popup]")!, { clientX: 184, clientY: 8 });
          } else {
            fireEvent.pointerEnter(child, { clientX: 190, clientY: 65 });
          }
          act(() => vi.advanceTimersByTime(500));
          expect(parent).toHaveClass(menuStyles.active!);
          expect(parent).toHaveAttribute("aria-expanded", "true");
          expect(onActive).not.toHaveBeenCalled();
        } else {
          if (choice === "move away") {
            fireEvent.pointerMove(sibling, { clientX: 60, clientY: 45 });
            expect(sibling).toHaveClass(menuStyles.active!);
            act(() => vi.advanceTimersByTime(200));
          } else {
            act(() => vi.advanceTimersByTime(50));
          }
          expect(parent).toHaveAttribute("aria-expanded", "false");
          expect(sibling).toHaveClass(menuStyles.active!);
          expect(onActive).toHaveBeenCalledTimes(1);
          if (choice === "switch submenu") expect(screen.getByText("Other child")).toBeInTheDocument();
        }
        unmount();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );

  it("follows context changes after the menu opened", () => {
    const dispose = registerAction({ id: "test.menuWhen", title: "Needs Flag", when: "qaMenuFlag", run: () => {} });
    setContext("qaMenuFlag", false);
    render(<MenuList items={[{ kind: "action", action: "test.menuWhen" }]} onDone={() => {}} />);
    expect(screen.getByRole("menuitem", { name: /Needs Flag/ })).toHaveAttribute("aria-disabled", "true");
    act(() => setContext("qaMenuFlag", true));
    expect(screen.getByRole("menuitem", { name: /Needs Flag/ })).not.toHaveAttribute("aria-disabled", "true");
    dispose();
  });

  describe("numeric mnemonics", () => {
    const rows = (n: number) => [...Array(n)].map((_, i) => ({ label: `Row ${i + 1}`, run: () => {} }));

    it("numbers the selectable rows in display order and skips headers and disabled rows", () => {
      render(
        <MenuList
          numbers
          items={[
            { kind: "header", label: "Select In" },
            { label: "Project View", run: () => {} },
            { label: "Disabled", disabled: true, run: () => {} },
            ...rows(9),
          ]}
          onDone={() => {}}
        />,
      );
      const digit = (name: string) =>
        screen.getByRole("menuitem", { name }).querySelector("[data-menu-number]")?.getAttribute("data-menu-number") ??
        null;
      expect(digit("Project View")).toBe("1");
      // The disabled row keeps the column but gets no digit.
      expect(screen.getByRole("menuitem", { name: "Disabled" }).querySelector('[aria-hidden="true"]')).toBeTruthy();
      expect(digit("Disabled")).toBeNull();
      expect(digit("Row 1")).toBe("2");
      expect(digit("Row 8")).toBe("9");
      // IDEA caps numeric mnemonics at nine: the tenth row shows the column, unnumbered.
      expect(digit("Row 9")).toBeNull();
    });

    it("activates the row of a digit without running speed search", () => {
      const run = vi.fn();
      const done = vi.fn();
      render(
        <MenuList
          numbers
          items={[
            { label: "Project View", run: () => {} },
            { label: "Terminal", run },
          ]}
          onDone={done}
        />,
      );
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Terminal" }), { key: "2" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("leaves a digit that numbers no row alone", () => {
      const run = vi.fn();
      render(<MenuList numbers items={[{ label: "Project View", run }]} onDone={() => {}} />);
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Project View" }), { key: "5" });
      expect(run).not.toHaveBeenCalled();
    });

    it("keeps first-letter speed search for non-digit keys", () => {
      const run = vi.fn();
      render(
        <MenuList
          numbers
          items={[
            { label: "Project View", run },
            { label: "Terminal", run: () => {} },
          ]}
          onDone={() => {}}
        />,
      );
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Project View" }), { key: "t" });
      expect(screen.getByRole("menuitem", { name: "Terminal" })).toHaveFocus();
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Terminal" }), { key: "Enter" });
      expect(run).not.toHaveBeenCalled();
    });

    it("does not number submenu rows", () => {
      render(
        <MenuList
          numbers
          items={[
            { label: "One", run: () => {} },
            { label: "Parent", submenu: [{ label: "Child", run: () => {} }] },
          ]}
          onDone={() => {}}
        />,
      );
      const menu = screen.getByRole("menu");
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      fireEvent.keyDown(menu, { key: "ArrowRight" });
      const submenu = document.querySelectorAll('[role="menu"]')[1]!;
      expect(submenu).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Child" })).toBeInTheDocument();
      expect(submenu.querySelectorAll("[data-menu-number]")).toHaveLength(0);
    });

    it("carries the option through the context menu store", () => {
      render(<ContextMenuHost />);
      act(() => showContextMenu({ x: 0, y: 0 }, rows(3), { numbers: true }));
      expect(screen.getByRole("menuitem", { name: "Row 1" })).toHaveFocus();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "3" });
      expect(useContextMenuStore.getState().menu).toBeNull();
      act(() => showContextMenu({ x: 0, y: 0 }, rows(3)));
      expect(document.querySelectorAll("[data-menu-number]")).toHaveLength(0);
      act(() => hideContextMenu());
    });
  });
});
