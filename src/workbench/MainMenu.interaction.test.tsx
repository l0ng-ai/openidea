import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerActions } from "@/platform/actions";
import { MainMenu } from "./MainMenu";

let available = 500;
let resize: () => void;
const savedProject = useProject.getState();
let dispose: () => void;
const setStyle = (style: string) =>
  useProject.setState({ settings: { appearance: { mainMenuStyle: style } } as Settings });
const alt = () => {
  fireEvent.keyDown(window, { key: "Alt", altKey: true });
  fireEvent.keyUp(window, { key: "Alt" });
};

beforeEach(() => {
  available = 500;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(element: HTMLElement) {
        if (element.className.includes("mainMenuSlot")) resize = this.callback;
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => available);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
  vi.spyOn(commands, "menuModel").mockResolvedValue([
    {
      kind: "submenu",
      id: "file",
      label: "File",
      children: [{ kind: "action", id: "test.open", label: "Open", hint: null, arg: null }],
    },
    {
      kind: "submenu",
      id: "edit",
      label: "Edit",
      children: [{ kind: "action", id: "test.undo", label: "Undo", hint: null, arg: null }],
    },
  ]);
  dispose = registerActions([
    { id: "test.open", title: "Open", category: "Test", run: vi.fn() },
    { id: "test.undo", title: "Undo", category: "Test", run: vi.fn() },
  ]);
  setStyle("hamburger");
});
afterEach(() => {
  dispose();
  useProject.setState(savedProject);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const titles = () => within(screen.getByRole("menubar"));

describe("main menu presentation", () => {
  it("keeps the hamburger default, expanding on click and collapsing on Escape", async () => {
    const expanded = vi.fn();
    render(<MainMenu onExpandedChange={expanded} />);
    expect(screen.queryByRole("menubar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
    expect(expanded).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
    expect(expanded).toHaveBeenLastCalledWith(false);
    alt();
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
  });

  it("shows merged titles, switches menus with arrows, and retains titles after dismissal or an action", async () => {
    setStyle("merged");
    const expanded = vi.fn();
    render(
      <>
        <MainMenu onExpandedChange={expanded} />
        <button>Toolbar control</button>
      </>,
    );
    await screen.findByRole("menubar");
    expect(screen.queryByRole("button", { name: "Main Menu" })).toBeNull();
    fireEvent.click(titles().getByRole("menuitem", { name: "File" }));
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    fireEvent.click(titles().getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Undo" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    fireEvent.click(titles().getByRole("menuitem", { name: "File" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Toolbar control" }));
    await act(() => new Promise((resolve) => setTimeout(resolve)));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(expanded).not.toHaveBeenCalledWith(true);
  });

  it.each(["hamburger", "merged"])(
    "%s switches on title clicks without an outside dismissal, then closes for toolbar clicks",
    async (style) => {
      setStyle(style);
      render(
        <>
          <MainMenu />
          <button>Toolbar control</button>
        </>,
      );
      if (style === "hamburger") fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
      await screen.findByRole("menubar");
      if (style === "merged") fireEvent.click(titles().getByRole("menuitem", { name: "File" }));
      const edit = titles().getByRole("menuitem", { name: "Edit" });
      fireEvent.pointerDown(edit);
      fireEvent.click(edit);
      await act(() => new Promise((resolve) => setTimeout(resolve)));
      expect(screen.getByRole("menu", { name: "Edit" })).toBeInTheDocument();
      fireEvent.pointerDown(screen.getByRole("button", { name: "Toolbar control" }));
      await act(() => new Promise((resolve) => setTimeout(resolve)));
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  it("focuses the merged titles with lone Alt and navigates before opening", async () => {
    setStyle("merged");
    render(
      <>
        <button>Editor</button>
        <MainMenu />
      </>,
    );
    await screen.findByRole("menubar");
    const editor = screen.getByRole("button", { name: "Editor" });
    editor.focus();
    alt();
    expect(titles().getByRole("menuitem", { name: "File" })).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(titles().getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(titles().getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(editor).toHaveFocus();
  });

  it("returns focus on a second lone Alt", async () => {
    setStyle("merged");
    render(
      <>
        <button>Editor</button>
        <MainMenu />
      </>,
    );
    await screen.findByRole("menubar");
    const editor = screen.getByRole("button", { name: "Editor" });
    editor.focus();
    alt();
    expect(titles().getByRole("menuitem", { name: "File" })).toHaveFocus();
    alt();
    expect(editor).toHaveFocus();
    alt();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(editor).toHaveFocus();
  });

  it("does not reopen a title's menu after the titles collapse and return", async () => {
    setStyle("merged");
    render(<MainMenu />);
    await screen.findByRole("menubar");
    fireEvent.click(titles().getByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    act(() => {
      available = 100;
      resize();
    });
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      available = 500;
      resize();
    });
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("falls back to a hamburger popup when narrow and restores titles when space returns", async () => {
    available = 100;
    setStyle("merged");
    const expanded = vi.fn();
    render(<MainMenu onExpandedChange={expanded} />);
    await act(async () => {});
    expect(screen.queryByRole("menubar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    const root = await screen.findByRole("menu", { name: "Main Menu" });
    fireEvent.click(within(root).getByRole("menuitem", { name: /File/ }));
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
    expect(expanded).not.toHaveBeenCalledWith(true);
    act(() => {
      available = 500;
      resize();
    });
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Main Menu" })).toBeNull();
    act(() => {
      available = 100;
      resize();
    });
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
  });

  it("applies the setting immediately and restores toolbar visibility when switching from an expanded hamburger", async () => {
    const expanded = vi.fn();
    render(<MainMenu onExpandedChange={expanded} />);
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    await screen.findByRole("menu");
    expect(expanded).toHaveBeenLastCalledWith(true);
    act(() => setStyle("merged"));
    await screen.findByRole("menubar");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(expanded).toHaveBeenLastCalledWith(false);
    act(() => setStyle("hamburger"));
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
  });
});
