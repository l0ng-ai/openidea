import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
const { closePopup, openPopup, updatePopup, useLspPopup } = await import("./popupStore");
const { useDocWindow, hoverDoc, pushHistory, stepHistory, hoverCandidates } = await import("./docs");
const { mountHoverDoc } = await import("./DocView");
const { hoverSource } = await import("./hover");
import { registerImportsOnPasteActions } from "./importsOnPaste";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CONTRIBUTED_HOVER, type ContributedHover } from "@/editor/api";

const loc = (path: string, line: number): Location => ({
  path,
  range: { start: { line, col: 4 }, end: { line, col: 7 } },
});

afterEach(() => {
  act(() => closePopup());
  vi.clearAllMocks();
});

describe("imports on paste dialog", () => {
  it("checks all imports by default and applies only the selected ones through its action", () => {
    const dispose = registerImportsOnPasteActions();
    const onApply = vi.fn();
    openPopup({
      kind: "importsOnPaste",
      imports: ["Import java.util.List", "Import java.util.Map"],
      onApply,
      onClose: vi.fn(),
    });
    render(<LspPopups />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    boxes.forEach((box) => expect(box).toBeChecked());
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Add Imports" }));
    expect(onApply).toHaveBeenCalledWith([0]);
    fireEvent.click(boxes[0]!);
    expect(screen.getByRole("button", { name: "Add Imports" })).toBeDisabled();
    dispose();
  });

  it("Cancel dismisses the dialog without applying imports", () => {
    const onClose = vi.fn();
    const onApply = vi.fn();
    openPopup({ kind: "importsOnPaste", imports: ["Import java.util.List"], onApply, onClose });
    render(<LspPopups />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    expect(useLspPopup.getState().popup).toBeNull();
  });
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

  it("keeps the chosen intention when a quick-fix section arrives ahead of it", () => {
    const local = ["Extract variable", "Inline value"].map((label) => ({
      id: label,
      label,
      section: { id: "intentions" },
      run: vi.fn(),
    }));
    openPopup({ kind: "list", title: "Intentions", anchor: { x: 0, y: 0 }, items: local, busy: true });
    render(<LspPopups />);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Inline value", selected: true })).toBeVisible();

    const runFix = vi.fn();
    act(() =>
      updatePopup("list", {
        busy: false,
        items: [{ id: "fix", label: "Correct type", section: { id: "quick-fixes" }, run: runFix }, ...local],
      }),
    );
    expect(screen.getByRole("option", { name: "Inline value", selected: true })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(local[1]!.run).toHaveBeenCalledOnce();
    expect(runFix).not.toHaveBeenCalled();
  });

  it("focuses the rows, not the header's pin button, when it opens", () => {
    openPopup({
      kind: "list",
      anchor: { x: 0, y: 0 },
      title: "Choose Declaration of foo (2 found)",
      items: [
        { id: "a", label: "foo", run: vi.fn() },
        { id: "b", label: "foo", run: vi.fn() },
      ],
      pin: { label: "Open in Find Tool Window", run: vi.fn() },
    });
    render(<LspPopups />);
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
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
      const preview = vi.fn(async () => ({
        kind: "diff" as const,
        lines: [{ kind: "added" as const, text: "let x = 1;" }],
      }));
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
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenCalledWith("/p/b.ts", { selection: { line: 3, col: 4 }, focus: true }),
    );
    expect(container).toBeTruthy();
  });

  it("navigates the popup history from More Actions and moves it to the Documentation tool window", () => {
    openPopup({
      kind: "doc",
      anchor: { x: 0, y: 0 },
      entries: [
        { markup: { kind: "plaintext", value: "First document" }, language: null },
        { markup: { kind: "plaintext", value: "Second document" }, language: null },
      ],
      index: 1,
      themeClasses: "",
    });
    render(
      <>
        <LspPopups />
        <DocumentationWindow />
      </>,
    );
    const more = screen.getByRole("button", { name: "More Actions" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Back/ }));
    expect(screen.getByText("First document")).toBeVisible();
    fireEvent.click(more);
    expect(screen.getByRole("menuitem", { name: /^Forward/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Show in Documentation Tool Window/ }));
    expect(useLspPopup.getState().popup).toBeNull();
    expect(show).toHaveBeenCalledWith("documentation", true);
    expect(useDocWindow.getState().entries).toHaveLength(2);
    expect(useDocWindow.getState().index).toBe(0);
  });
});

describe("hover documentation", () => {
  const text = (value: string) => ({ markup: { kind: "plaintext" as const, value }, language: null });
  const frame = (el: Element) => el.querySelector<HTMLElement>('[data-lsp-doc="hover"]')!;
  afterEach(() => document.body.replaceChildren());

  it("shows the hovered documentation in the same view as F1's, laid out when create() returns", async () => {
    const docHover: ContributedHover = (state, pos) => {
      const w = state.wordAt(pos);
      return w ? { from: w.from, to: w.to, markdown: "hovered docs" } : null;
    };
    const view = new EditorView({
      state: EditorState.create({
        doc: "query.FlightPlan",
        extensions: [EditorState.languageData.of(() => [{ [CONTRIBUTED_HOVER]: docHover }])],
      }),
      parent: document.body.appendChild(document.createElement("div")),
    });
    const tooltip = await hoverSource(view, 2);
    let created!: { dom: HTMLElement; destroy: () => void };
    // Asserted inside a synchronous act(): `create()` has to leave a laid-out popup behind, since
    // CodeMirror places the tooltip in the measure pass that follows it.
    act(() => {
      created = tooltip!.create() as typeof created;
      expect(frame(created.dom).textContent).toContain("hovered docs");
    });
    await act(async () => void document.body.appendChild(created.dom));
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    created.destroy();
    view.destroy();
  });

  it("walks its history with ← / →; Edit Source closes the hover", async () => {
    const close = vi.fn();
    const source = vi.fn(async () => loc("/p/b.ts", 3));
    const doc = hoverDoc(text("first"), close);
    doc.setState({ entries: [text("first"), { ...text("second"), source }], index: 1 });
    const el = document.body.appendChild(document.createElement("div"));
    await act(async () => void mountHoverDoc(el, doc));
    expect(frame(el).textContent).toContain("second");
    fireEvent.keyDown(frame(el), { key: "ArrowLeft" });
    expect(frame(el).textContent).toContain("first");
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(frame(el).textContent).toContain("second");
    fireEvent.keyDown(frame(el), { key: "F4" });
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenCalledWith("/p/b.ts", { selection: { line: 3, col: 4 }, focus: true }),
    );
    expect(close).toHaveBeenCalled();
  });

  it("keeps each hover's history apart (an editor shown again brings its hover back)", async () => {
    const [a, b] = [hoverDoc(text("in a.go"), vi.fn()), hoverDoc(text("in b.rs"), vi.fn())];
    const [elA, elB] = [0, 1].map(() => document.body.appendChild(document.createElement("div")));
    await act(async () => {
      mountHoverDoc(elA!, a);
      mountHoverDoc(elB!, b);
    });
    await act(async () => b.setState({ entries: [text("in b.rs"), text("followed in b.rs")], index: 1 }));
    expect(frame(elA!).textContent).toContain("in a.go");
    expect(frame(elB!).textContent).toContain("followed in b.rs");
  });

  it("moves its history to the Documentation tool window", async () => {
    const close = vi.fn();
    const el = document.body.appendChild(document.createElement("div"));
    await act(async () => void mountHoverDoc(el, hoverDoc(text("hovered"), close)));
    fireEvent.click(screen.getByRole("button", { name: "Show in Documentation Tool Window" }));
    expect(close).toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith("documentation", true);
    expect(useDocWindow.getState().entries[0]?.markup.value).toBe("hovered");
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
      codeStyle: { fontSize: "16px", lineHeight: "24px" },
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

describe("reformat dialog", () => {
  it("offers only whole-file formatting when the editor has no selection", () => {
    const onRun = vi.fn();
    openPopup({
      kind: "reformat",
      title: "Reformat File",
      hasSelection: false,
      canOptimizeImports: true,
      initial: { selectionOnly: false, optimizeImports: false },
      onRun,
    });
    render(<LspPopups />);
    const scope = within(screen.getByRole("group", { name: "Scope" }));
    expect(scope.getByRole("radio", { name: "Selected text" })).toBeDisabled();
    expect(scope.getByRole("radio", { name: "Whole file" })).toBeChecked();
    expect(within(screen.getByRole("group", { name: "Options" })).getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledWith({ selectionOnly: false, optimizeImports: false });
  });
});
