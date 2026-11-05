import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { Dialog, dialogPlatformOf, orderDialogButtons, type DialogButton, type DialogPlatform } from "./Dialog";

const labels = (bs: readonly DialogButton[]) => bs.map((b) => b.label);

function safeDelete(handlers: { view?: () => void; anyway?: () => void; cancel?: () => void } = {}): DialogButton[] {
  return [
    { label: "View Usages", role: "default", onClick: handlers.view ?? (() => {}) },
    { label: "Delete Anyway", onClick: handlers.anyway ?? (() => {}) },
    { label: "Cancel", role: "cancel", onClick: handlers.cancel },
  ];
}

function footerLabels() {
  const footer = document.querySelector("[data-dialog-footer]") as HTMLElement;
  return within(footer)
    .getAllByRole("button")
    .map((b) => b.textContent);
}

describe("orderDialogButtons", () => {
  it("macOS: Cancel first, the default button last (IDEA sortActionsOnMac)", () => {
    expect(labels(orderDialogButtons(safeDelete(), "mac"))).toEqual(["Cancel", "Delete Anyway", "View Usages"]);
    const settings: DialogButton[] = [
      { label: "OK", role: "default" },
      { label: "Cancel", role: "cancel" },
      { label: "Apply" },
    ];
    expect(labels(orderDialogButtons(settings, "mac"))).toEqual(["Cancel", "Apply", "OK"]);
  });

  it("Windows / Linux: the default button first, then declaration order", () => {
    expect(labels(orderDialogButtons(safeDelete(), "other"))).toEqual(["View Usages", "Delete Anyway", "Cancel"]);
    const settings: DialogButton[] = [
      { label: "Cancel", role: "cancel" },
      { label: "Apply" },
      { label: "OK", role: "default" },
    ];
    expect(labels(orderDialogButtons(settings, "other"))).toEqual(["OK", "Cancel", "Apply"]);
  });

  it("maps host OS to chrome", () => {
    expect(dialogPlatformOf("macos")).toBe("mac");
    expect(dialogPlatformOf("web")).toBe("mac");
    expect(dialogPlatformOf("windows")).toBe("other");
    expect(dialogPlatformOf("linux")).toBe("other");
  });
});

describe("Dialog chrome", () => {
  const initialOs = usePlatform.getState().os;
  afterEach(() => usePlatform.setState({ os: initialOs }));

  const show = (platform?: DialogPlatform, onClose = vi.fn()) =>
    render(
      <Dialog open onClose={onClose} title="Usages Detected" buttons={safeDelete()} platform={platform}>
        <p>Usages found</p>
      </Dialog>,
    );

  it("macOS: traffic lights (only close enabled), title after them, Cancel … default rightmost", () => {
    const onClose = vi.fn();
    show("mac", onClose);
    const bar = document.querySelector("[data-dialog-titlebar]") as HTMLElement;
    const lights = within(bar).getAllByRole("button");
    expect(lights.map((b) => b.getAttribute("aria-label"))).toEqual(["Close", "Minimize", "Zoom"]);
    expect(lights[1]).toBeDisabled();
    expect(lights[2]).toBeDisabled();
    expect(bar.textContent).toBe("Usages Detected");
    expect(footerLabels()).toEqual(["Cancel", "Delete Anyway", "View Usages"]);
    fireEvent.click(lights[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Windows / Linux: title then a close button, default leftmost", () => {
    const onClose = vi.fn();
    show("other", onClose);
    const bar = document.querySelector("[data-dialog-titlebar]") as HTMLElement;
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Close"]);
    expect(footerLabels()).toEqual(["View Usages", "Delete Anyway", "Cancel"]);
    fireEvent.click(within(bar).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("follows the host platform by default", () => {
    usePlatform.setState({ os: "windows" });
    show();
    expect(footerLabels()).toEqual(["View Usages", "Delete Anyway", "Cancel"]);
  });

  it("popups (top / untitled) get no window title bar", () => {
    render(
      <Dialog open onClose={() => {}} aria-label="Recent Files">
        <button>row</button>
      </Dialog>,
    );
    expect(document.querySelector("[data-dialog-titlebar]")).toBeNull();
  });

  it("drags a popup by a [data-dialog-drag] handle, but not by its controls or body", () => {
    render(
      <Dialog open onClose={() => {}} position="top" aria-label="Search Everywhere">
        <div data-dialog-drag="">
          <span>header</span>
          <button>tab</button>
        </div>
        <div>rows</div>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    const handle = dialog.querySelector("[data-dialog-drag]")!;
    const down = (el: Element, x: number) => fireEvent.pointerDown(el, { button: 0, clientX: x, clientY: 10 });
    down(handle.querySelector("button")!, 10);
    down(dialog.querySelector("div:last-child")!, 10);
    expect(dialog.style.translate).toBe("");
    down(handle, 10);
    fireEvent.pointerMove(window, { buttons: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(window);
    expect(dialog.style.translate).toBe("190px 30px");
  });

  it("resizes a top popup by its corner, keeping its top edge, and reports the size", () => {
    const onResized = vi.fn();
    render(
      <Dialog
        open
        onClose={() => {}}
        position="top"
        aria-label="Find in Files"
        width={400}
        resizable="both"
        minWidth={200}
        minHeight={100}
        onResized={onResized}
      >
        <div>rows</div>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize" }), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerUp(window);
    expect([dialog.style.width, dialog.style.height]).toEqual(["500px", "300px"]);
    expect(dialog.style.translate).toBe("250px 0px");
    expect(onResized).toHaveBeenCalledExactlyOnceWith({ w: 500, h: 300 });
  });

  it("opens a resizable popup at a remembered size", () => {
    render(
      <Dialog
        open
        onClose={() => {}}
        position="top"
        aria-label="Find in Files"
        resizable="both"
        initialSize={{ w: 600, h: 400 }}
      >
        <div>rows</div>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect([dialog.style.width, dialog.style.height]).toEqual(["600px", "400px"]);
  });

  it("caps a content-sized dialog at maxHeight until it is resized", () => {
    render(
      <Dialog open onClose={() => {}} title="Push" resizable="both" maxHeight={720}>
        <div>rows</div>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.maxHeight).toBe("min(720px, 100%)");
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize" }), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 500, clientY: 800 });
    fireEvent.pointerUp(window);
    expect(dialog.style.maxHeight).toBe("");
    expect(dialog.style.height).not.toBe("");
  });

  it("still drags a window dialog by its title bar", () => {
    render(
      <Dialog open onClose={() => {}} title="Usages Detected" buttons={safeDelete()} platform="other">
        <p>Usages found</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    const bar = document.querySelector("[data-dialog-titlebar]") as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(window);
    expect(dialog.style.translate).toBe("80px 30px");
    // The close button never starts a drag.
    fireEvent.pointerDown(within(bar).getByRole("button", { name: "Close" }), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 200, clientY: 40 });
    fireEvent.pointerUp(window);
    expect(dialog.style.translate).toBe("80px 30px");
  });

  it("renders the help button and footer start on the left", () => {
    const onHelp = vi.fn();
    render(
      <Dialog
        open
        onClose={() => {}}
        title="T"
        onHelp={onHelp}
        footerStart={<span>status</span>}
        buttons={safeDelete()}
        platform="mac"
      >
        <p>x</p>
      </Dialog>,
    );
    expect(footerLabels()[0]).toBe("?");
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(onHelp).toHaveBeenCalled();
  });
});

describe("Dialog keyboard", () => {
  it("Enter runs the default button, Escape cancels", () => {
    const view = vi.fn();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Usages Detected" buttons={safeDelete({ view })} platform="mac">
        <input aria-label="Name" />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    expect(view).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter is left to text areas, buttons and handlers that consumed it; disabled default does nothing", () => {
    const ok = vi.fn();
    const { rerender } = render(
      <Dialog
        open
        onClose={() => {}}
        title="T"
        buttons={[
          { label: "OK", role: "default", onClick: ok },
          { label: "Cancel", role: "cancel" },
        ]}
      >
        <textarea aria-label="Message" />
        <input aria-label="Own" onKeyDown={(e) => e.key === "Enter" && e.preventDefault()} />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    fireEvent.keyDown(screen.getByLabelText("Own"), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Enter" });
    expect(ok).not.toHaveBeenCalled();
    // ⌘Enter submits from a text area.
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter", metaKey: true });
    expect(ok).toHaveBeenCalledTimes(1);
    rerender(
      <Dialog
        open
        onClose={() => {}}
        title="T"
        buttons={[{ label: "OK", role: "default", onClick: ok, disabled: true }]}
      >
        <input aria-label="Field" />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("Field"), { key: "Enter" });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("a cancel button without a handler closes the dialog", () => {
    const onClose = vi.fn();
    render(
      <Dialog
        open
        onClose={onClose}
        title="T"
        buttons={[
          { label: "OK", role: "default", onClick: () => {} },
          { label: "Cancel", role: "cancel" },
        ]}
      >
        <p>x</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the default button when the content has no controls; Tab skips the title bar", () => {
    render(
      <Dialog open onClose={() => {}} title="Usages Detected" buttons={safeDelete()} platform="mac">
        <p>Usages found</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "View Usages" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});
