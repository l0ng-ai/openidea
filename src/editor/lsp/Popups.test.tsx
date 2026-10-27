import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Location } from "@/bindings";

const openFile = vi.fn(async () => undefined);
const show = vi.fn();
vi.mock("@/workbench/contributions", async (orig) => {
  const actual = await orig<typeof import("@/workbench/contributions")>();
  return {
    ...actual,
    editorService: () => ({ openFile }),
    maybeEditorService: () => ({ openFile }),
    toolWindowService: () => ({ show, hide: vi.fn(), toggle: vi.fn(), isVisible: () => false }),
  };
});

const { LspPopups, DocumentationWindow } = await import("./Popups");
const { closePopup, openPopup, useLspPopup } = await import("./popupStore");
const { useDocWindow, pushHistory, stepHistory, hoverCandidates } = await import("./docs");

const loc = (path: string, line: number): Location => ({
  path,
  range: { start: { line, col: 4 }, end: { line, col: 7 } },
});

afterEach(() => {
  act(() => closePopup());
  vi.clearAllMocks();
});

describe("list popup", () => {
  it("numbers rows 1-9 and runs a row by its number", () => {
    const run = vi.fn();
    openPopup({
      kind: "list",
      anchor: { x: 0, y: 0 },
      title: "Refactor This",
      numbered: true,
      items: [
        { id: "a", label: "Rename…", run: vi.fn() },
        { id: "b", label: "Inline…", run },
      ],
    });
    render(<LspPopups />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["1Rename…", "2Inline…"]);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "2" });
    expect(run).toHaveBeenCalledOnce();
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("opens a row's → menu with the right arrow and runs its items", () => {
    const disable = vi.fn();
    const fix = vi.fn();
    openPopup({
      kind: "list",
      anchor: { x: 0, y: 0 },
      title: "Intentions",
      items: [
        {
          id: "fix",
          label: "Typo: Change to…",
          run: fix,
          submenu: [
            { label: "Edit inspection profile setting", run: vi.fn() },
            { label: "Disable inspection", run: disable },
          ],
        },
      ],
    });
    render(<LspPopups />);
    expect(screen.getByRole("button", { name: "Typo: Change to… options" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowRight" });
    const menu = screen.getByRole("menu", { name: "Typo: Change to…" });
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual([
      "Edit inspection profile setting",
      "Disable inspection",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable inspection" }));
    expect(disable).toHaveBeenCalledOnce();
    expect(fix).not.toHaveBeenCalled();
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("reports the selected row and cleans up on close", () => {
    const onActive = [vi.fn(), vi.fn()];
    const onClose = vi.fn();
    openPopup({
      kind: "list",
      anchor: { x: 0, y: 0 },
      title: "Expressions",
      items: onActive.map((fn, i) => ({ id: `${i}`, label: `e${i}`, run: vi.fn(), onActive: fn })),
      onClose,
    });
    render(<LspPopups />);
    expect(onActive[0]).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(onActive[1]).toHaveBeenCalledOnce();
    act(() => closePopup());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("pins the results elsewhere from the header button", () => {
    const pin = vi.fn();
    openPopup({
      kind: "list",
      anchor: { x: 0, y: 0 },
      title: "Choose Declaration of foo (2 found)",
      items: [{ id: "a", label: "foo", run: vi.fn() }],
      pin: { label: "Open in Find Tool Window", run: pin },
    });
    render(<LspPopups />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Find Tool Window" }));
    expect(pin).toHaveBeenCalledOnce();
    expect(useLspPopup.getState().popup).toBeNull();
  });

  it("shows the selected row's preview, fetched lazily", async () => {
    vi.useFakeTimers();
    try {
      const preview = vi.fn(async () => ({ kind: "diff" as const, lines: [{ kind: "added" as const, text: "let x = 1;" }] }));
      openPopup({
        kind: "list",
        anchor: { x: 0, y: 0 },
        title: "Intentions",
        items: [{ id: "a", label: "Introduce local variable", run: vi.fn() }],
        preview,
      });
      render(<LspPopups />);
      expect(preview).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(preview).toHaveBeenCalledOnce();
      expect(screen.getByLabelText("Preview").textContent).toBe("let x = 1;");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("documentation", () => {
  it("history helpers drop forward entries and clamp steps", () => {
    const e = (v: string) => ({ markup: { kind: "plaintext" as const, value: v }, language: null });
    const h = pushHistory({ entries: [e("a"), e("b"), e("c")], index: 0 }, e("d"));
    expect(h.entries.map((x) => x.markup.value)).toEqual(["a", "d"]);
    expect(h.index).toBe(1);
    expect(stepHistory(h, 1)).toBe(1);
    expect(stepHistory(h, -1)).toBe(0);
  });

  it("asks about the declared name when a link points at the start of a declaration", () => {
    expect(hoverCandidates("export class Foo extends Bar {", 0)).toEqual([0, 13, 25]);
  });

  it("walks the popup history with ← / → and opens the source with F4", async () => {
    const source = vi.fn(async () => loc("/p/b.ts", 3));
    openPopup({
      kind: "doc",
      anchor: { x: 0, y: 0 },
      entries: [
        { markup: { kind: "plaintext", value: "first" }, language: null },
        { markup: { kind: "plaintext", value: "second" }, language: null, source },
      ],
      index: 1,
      themeClasses: "",
    });
    const { container } = render(<LspPopups />);
    const frame = () => document.querySelector<HTMLElement>("[data-lsp-doc]")!;
    expect(frame().textContent).toContain("second");
    fireEvent.keyDown(frame(), { key: "ArrowLeft" });
    expect(frame().textContent).toContain("first");
    expect(screen.queryByRole("button", { name: "Edit Source" })).toBeNull();
    fireEvent.keyDown(frame(), { key: "ArrowRight" });
    expect(frame().textContent).toContain("second");
    fireEvent.keyDown(frame(), { key: "F4" });
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith("/p/b.ts", { selection: { line: 3, col: 4 }, focus: true }));
    expect(container).toBeTruthy();
  });

  it("moves the popup to the Documentation tool window", () => {
    openPopup({
      kind: "doc",
      anchor: { x: 0, y: 0 },
      entries: [{ markup: { kind: "plaintext", value: "docs" }, language: null }],
      index: 0,
      themeClasses: "",
    });
    render(
      <>
        <LspPopups />
        <DocumentationWindow />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show in Documentation Tool Window" }));
    expect(useLspPopup.getState().popup).toBeNull();
    expect(show).toHaveBeenCalledWith("documentation", true);
    expect(useDocWindow.getState().entries).toHaveLength(1);
  });
});

describe("quick definition popup", () => {
  it("switches between several definitions with ← / → and edits the source with F4", () => {
    openPopup({
      kind: "definition",
      anchor: { x: 0, y: 0 },
      targets: [
        { location: loc("/p/a.ts", 1), name: "run", firstLine: 0, text: "function run() {}", language: null },
        { location: loc("/p/b.ts", 5), name: "run", firstLine: 4, text: "run(): void;", language: null },
      ],
      index: 0,
      themeClasses: "",
    });
    render(<LspPopups />);
    const frame = () => screen.getByRole("dialog", { name: "Definition" }).firstElementChild as HTMLElement;
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(frame(), { key: "ArrowRight" });
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(frame().textContent).toContain("run(): void;");
    fireEvent.keyDown(frame(), { key: "F4" });
    expect(openFile).toHaveBeenCalledWith("/p/b.ts", { selection: { line: 5, col: 4 }, focus: true });
  });
});
