import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { registerAction } from "@/platform/actions";
import type { SeDeps } from "../everywhere/controller";

const defaultFindFiles: SeDeps["findFiles"] = async (q) =>
  q ? [{ path: "/p/src/OrderController.kt", relPath: "src/OrderController.kt", score: 1, indices: [4, 5, 6] }] : [];
let findFiles = defaultFindFiles;
let findSymbols: SeDeps["findSymbols"] = async () => [];
let settings: NonNullable<SeDeps["settings"]> = async () => [];
const fakeDeps = (): SeDeps => ({
  findFiles: (...args) => findFiles(...args),
  findSymbols: (...args) => findSymbols(...args),
  settings: () => settings(),
  searchText: async () => {},
  cancel: () => {},
  nextRequestId: () => 1,
  actions: () => [...(globalThis as unknown as { __actions: () => [] }).__actions()],
  isEnabled: () => true,
  recentFiles: async () => ["/p/README.md"],
  recentActions: () => [],
  root: () => "/p",
  now: () => 0,
});

vi.mock("../common/open", async (orig) => ({
  ...(await orig<typeof import("../common/open")>()),
  openLocation: vi.fn(async () => {}),
}));

vi.mock("../everywhere/deps", () => ({
  ipcDeps: () => fakeDeps(),
  loadLanguages: async () => [
    { id: "kotlin", name: "Kotlin", extensions: ["kt"] },
    { id: "markdown", name: "Markdown", extensions: ["md"] },
  ],
}));
vi.mock("../find/windowStore", async (orig) => ({
  ...(await orig<typeof import("../find/windowStore")>()),
  ipcFindDeps: () => ({
    validate: async () => {},
    start: async (_id: number, _q: unknown, onFile: (f: unknown) => void) => {
      onFile({
        path: "/p/a.kt",
        relPath: "a.kt",
        matches: [{ line: 2, text: "val order = 1", ranges: [[4, 9]], textOffset: 0 }],
      });
      return null;
    },
    cancel: () => {},
    nextRequestId: () => 1,
  }),
}));

const contributions = await import("@/workbench/contributions");
const { commands } = await import("@/platform/ipc");
const { RecentPopupsOverlay } = await import("../recent/RecentPopups");
const { showRecentPopup, hideRecentPopup, useRecentPopup } = await import("../recent/store");
const { openLocation } = await import("../common/open");
const { usePlatform } = await import("@/platform/platformInfo");
const { allActions } = await import("@/platform/actions");
(globalThis as unknown as { __actions: typeof allActions }).__actions = allActions;
const { SearchEverywhereOverlay } = await import("../everywhere/SearchEverywhere");
const { showSearchEverywhere, hideSearchEverywhere, useSearchEverywhere, pushSearchHistory, searchHistory } =
  await import("../everywhere/store");
const { FindInFilesOverlay } = await import("../find/FindInFiles");
const { showFindPopup, hideFindPopup } = await import("../find/store");

const tick = () => act(() => new Promise((r) => setTimeout(r, 100)));

beforeEach(() => {
  findFiles = defaultFindFiles;
  findSymbols = async () => [];
  settings = async () => [];
  vi.mocked(openLocation).mockClear();
});

afterEach(() => {
  act(() => {
    hideSearchEverywhere();
    hideFindPopup();
    hideRecentPopup();
  });
});

describe("Search Everywhere dialog", () => {
  it("shows recent files for an empty query, then flat results; Enter runs an action", async () => {
    const run = vi.fn();
    const dispose = registerAction({ id: "test.order", title: "Order Pizza", category: "Test", run });
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all"));
    await tick();
    expect(screen.getByText("Recent Files")).toBeInTheDocument();
    expect(within(document.getElementById("se-results")!).getByText("README.md")).toBeInTheDocument();

    const input = screen.getByLabelText("Search query");
    fireEvent.change(input, { target: { value: "ord" } });
    await tick();
    const results = within(document.getElementById("se-results")!);
    expect(results.queryByText("Files")).toBeNull();
    // All mixes sources by relevance: the shorter prefix hit (the action) leads.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("src/OrderController.kt")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(useSearchEverywhere.getState().open).toBe(false);
    expect(run).toHaveBeenCalled();
    dispose();
  });

  it("the preview toggle is remembered", async () => {
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all"));
    await tick();
    const toggle = screen.getByRole("button", { name: "Preview" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(useSearchEverywhere.getState().preview).toBe(true);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("openidea.search.everywherePreview.v1")).toBe("true");
    fireEvent.click(toggle);
    expect(useSearchEverywhere.getState().preview).toBe(false);
  });

  it("/ lists scope commands; picking one or typing '/files q' switches the tab", async () => {
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all", { query: "" }));
    await tick();
    const input = screen.getByLabelText("Search query");
    fireEvent.change(input, { target: { value: "/fi" } });
    await tick();
    expect(within(document.getElementById("se-results")!).getByText("/files")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSearchEverywhere.getState()).toMatchObject({ tab: "files", query: "", open: true });

    fireEvent.change(input, { target: { value: "/text order" } });
    expect(useSearchEverywhere.getState()).toMatchObject({ tab: "text", query: "order" });
  });

  it("⌥↑ / ⌥↓ browse the tab's search history and restore the draft", async () => {
    localStorage.removeItem("openidea.search.everywhereHistory.v1");
    pushSearchHistory("all", "older");
    pushSearchHistory("all", "newer");
    pushSearchHistory("files", "other tab");
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all", { query: "draft" }));
    await tick();
    const input = screen.getByLabelText("Search query");
    const key = (k: string) => fireEvent.keyDown(input, { key: k, altKey: true });
    key("ArrowUp");
    expect(useSearchEverywhere.getState().query).toBe("newer");
    key("ArrowUp");
    key("ArrowUp");
    expect(useSearchEverywhere.getState().query).toBe("older");
    key("ArrowDown");
    key("ArrowDown");
    expect(useSearchEverywhere.getState().query).toBe("draft");
    expect(searchHistory("all")).toEqual(["newer", "older"]);
  });

  it("⇥ cycles scopes and repeating the scope action toggles non-project items", async () => {
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all"));
    await tick();
    const input = screen.getByLabelText("Search query");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(useSearchEverywhere.getState().tab).toBe("classes");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(useSearchEverywhere.getState().tab).toBe("text");
    // Double Shift on another tab switches to All, keeping the query; on All it toggles the scope.
    fireEvent.change(input, { target: { value: "kept" } });
    act(() => showSearchEverywhere("all", { query: "selection" }));
    expect(useSearchEverywhere.getState()).toMatchObject({ tab: "all", query: "kept", includeNonProject: false });
    act(() => showSearchEverywhere("all"));
    expect(useSearchEverywhere.getState().includeNonProject).toBe(true);
  });

  it("labels the Actions tab's checkbox and assigns a shortcut with ⌥↵", async () => {
    const assign = vi.fn();
    const disposers = [
      registerAction({ id: "test.pizza", title: "Order Pizza", category: "Test", run: () => {} }),
      registerAction({ id: "settings.assignShortcut", title: "Assign", hidden: true, run: ({ arg }) => assign(arg) }),
    ];
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("actions", { query: "order pizza" }));
    await tick();
    expect(screen.getByLabelText("Include disabled actions")).toBeInTheDocument();
    expect(screen.queryByLabelText("Include non-project items")).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter", altKey: true });
    await tick();
    expect(assign).toHaveBeenCalledWith("test.pizza");
    expect(useSearchEverywhere.getState().open).toBe(false);
    disposers.forEach((d) => d());
  });

  it("filters Files by file type from the funnel, remembering the choice", async () => {
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("files", { query: "order" }));
    await tick();
    expect(document.getElementById("se-results")!.textContent).toContain("OrderController");
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await tick();
    fireEvent.click(screen.getByLabelText("Kotlin"));
    await tick();
    expect(useSearchEverywhere.getState().filters.files.languages).toEqual(["kotlin"]);
    expect(JSON.parse(localStorage.getItem("openidea.search.everywhereFilters.v1")!).files.languages).toEqual([
      "kotlin",
    ]);
    expect(document.getElementById("se-results")!.textContent).not.toContain("OrderController");
    act(() =>
      useSearchEverywhere.setState({
        filters: { ...useSearchEverywhere.getState().filters, files: { languages: [] } },
      }),
    );
  });

  it("searches everywhere when nothing is found in the project", async () => {
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("symbols", { query: "zzz" }));
    await tick();
    expect(useSearchEverywhere.getState()).toMatchObject({ includeNonProject: true, notFound: "zzz" });
    // A query that no longer contains the not-found one narrows back to the project.
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "other" } });
    expect(useSearchEverywhere.getState()).toMatchObject({ includeNonProject: false, notFound: null });
  });
});

const duplicateFiles: Awaited<ReturnType<SeDeps["findFiles"]>> = ["one", "two", "three"].map((dir) => ({
  path: `/p/${dir}/index.ts`,
  relPath: `${dir}/index.ts`,
  score: 1,
  indices: [0, 1, 2, 3, 4],
}));
const resultOptions = () => within(document.getElementById("se-results")!).getAllByRole("option");
const selectedOptions = () => resultOptions().filter((r) => r.getAttribute("aria-selected") === "true");
async function showDuplicateFiles() {
  findFiles = async () => duplicateFiles;
  render(<SearchEverywhereOverlay />);
  act(() => showSearchEverywhere("files", { query: "index" }));
  await tick();
  return screen.getByLabelText("Search query");
}
function clickOption(index: number, modifiers = {}) {
  const row = resultOptions()[index]!;
  fireEvent.mouseDown(row, modifiers);
  fireEvent.click(row, modifiers);
}

describe("Search Everywhere multi-selection", () => {
  it("extends, shrinks, crosses the anchor and clamps Shift selection; plain arrows select one", async () => {
    const input = await showDuplicateFiles();
    const key = (key: string, shiftKey = true) => fireEvent.keyDown(input, { key, shiftKey });
    key("ArrowDown", false);
    key("ArrowDown");
    expect(selectedOptions()).toEqual(resultOptions().slice(1));
    key("ArrowDown");
    expect(selectedOptions()).toHaveLength(2);
    key("ArrowUp");
    expect(selectedOptions()).toEqual([resultOptions()[1]]);
    key("ArrowUp");
    expect(selectedOptions()).toEqual(resultOptions().slice(0, 2));
    key("ArrowDown", false);
    expect(selectedOptions()).toEqual([resultOptions()[1]]);
    expect(screen.getByRole("listbox", { name: "Results" })).toHaveAttribute("aria-multiselectable", "true");
  });

  it("Shift-click selects a range without opening; an ordinary click opens just that file", async () => {
    await showDuplicateFiles();
    clickOption(2, { shiftKey: true });
    expect(selectedOptions()).toHaveLength(3);
    expect(openLocation).not.toHaveBeenCalled();
    expect(useSearchEverywhere.getState().open).toBe(true);
    clickOption(1);
    await tick();
    expect(openLocation).toHaveBeenCalledExactlyOnceWith("/p/two/index.ts", null, { side: false });
    expect(useSearchEverywhere.getState().open).toBe(false);
  });

  it.each(["macos", "windows", "linux"] as const)("uses the primary modifier to toggle a row on %s", async (os) => {
    const previous = usePlatform.getState().os;
    usePlatform.setState({ os });
    try {
      const input = await showDuplicateFiles();
      const modifier = os === "macos" ? { metaKey: true } : { ctrlKey: true };
      clickOption(2, modifier);
      expect(selectedOptions()).toEqual([resultOptions()[0], resultOptions()[2]]);
      clickOption(0, modifier);
      expect(selectedOptions()).toEqual([resultOptions()[2]]);
      expect(openLocation).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Enter" });
      await tick();
      expect(openLocation).toHaveBeenCalledExactlyOnceWith("/p/three/index.ts", null, { side: false });
    } finally {
      usePlatform.setState({ os: previous });
    }
  });

  it("awaits each open in list order, keeps tabs and restores an upward range's lead", async () => {
    const input = await showDuplicateFiles();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    let finishFirst!: () => void;
    vi.mocked(openLocation).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finishFirst = r;
        }),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(openLocation).toHaveBeenCalledTimes(1);
    expect(useSearchEverywhere.getState().open).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openLocation).toHaveBeenCalledTimes(1);
    expect(openLocation).toHaveBeenNthCalledWith(1, "/p/two/index.ts", null, {
      preview: false,
      focus: false,
      side: false,
    });
    await act(async () => finishFirst());
    await tick();
    expect(vi.mocked(openLocation).mock.calls).toEqual([
      ["/p/two/index.ts", null, { preview: false, focus: false, side: false }],
      ["/p/three/index.ts", null, { preview: false, focus: false, side: false }],
      ["/p/two/index.ts", null, { preview: false, focus: true, side: false }],
    ]);
    expect(useSearchEverywhere.getState().open).toBe(false);
  });

  it("resets selection immediately on query changes and tab switches", async () => {
    const input = await showDuplicateFiles();
    clickOption(2, { shiftKey: true });
    fireEvent.change(input, { target: { value: "index.t" } });
    expect(selectedOptions()).toHaveLength(1);
    await tick();
    clickOption(2, { shiftKey: true });
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(selectedOptions()).toHaveLength(1);
    await tick();
    expect(selectedOptions()).toHaveLength(1);
  });

  it.each(["classes", "symbols"] as const)("opens selected %s at their positions", async (tab) => {
    findSymbols = async () =>
      ["First", "Second"].map((name, line) => ({
        name,
        kind: tab === "classes" ? "class" : "function",
        container: null,
        path: `/p/${name}.ts`,
        relPath: `${name}.ts`,
        score: 1,
        indices: [0],
        range: { start: { line, col: 2 }, end: { line, col: 5 } },
      }));
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere(tab, { query: "s" }));
    await tick();
    const input = screen.getByLabelText("Search query");
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(openLocation).toHaveBeenNthCalledWith(
      1,
      "/p/First.ts",
      { line: 0, col: 2 },
      expect.objectContaining({ preview: false }),
    );
    expect(openLocation).toHaveBeenNthCalledWith(
      2,
      "/p/Second.ts",
      { line: 1, col: 2 },
      expect.objectContaining({ preview: false }),
    );
  });

  it("ignores actions and settings in a mixed selection even when the lead is an action", async () => {
    const run = vi.fn();
    const dispose = registerAction({ id: "test.index", title: "Index", category: "Test", run });
    findFiles = async () => duplicateFiles.slice(0, 2);
    settings = async () => [{ pageId: "editor", title: "Index", path: ["Editor"] }];
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("all", { query: "index" }));
    await tick();
    const input = screen.getByLabelText("Search query");
    const count = resultOptions().length;
    for (let i = 1; i < count; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    for (let i = 1; i < count; i++) fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    expect(selectedOptions()).toHaveLength(count);
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(run).not.toHaveBeenCalled();
    expect(vi.mocked(openLocation).mock.calls.map((c) => c[0])).toEqual([
      "/p/one/index.ts",
      "/p/two/index.ts",
      "/p/two/index.ts",
    ]);
    dispose();
  });

  it("does not execute a multi-selection containing only actions", async () => {
    const run = vi.fn();
    const disposers = ["One", "Two"].map((name) =>
      registerAction({ id: `test.index${name}`, title: `Index ${name}`, run }),
    );
    render(<SearchEverywhereOverlay />);
    act(() => showSearchEverywhere("actions", { query: "index" }));
    await tick();
    const input = screen.getByLabelText("Search query");
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(run).not.toHaveBeenCalled();
    expect(openLocation).not.toHaveBeenCalled();
    disposers.forEach((d) => d());
  });
});

describe("Recent Files multi-selection", () => {
  async function showFiles() {
    vi.spyOn(commands, "recentFiles").mockResolvedValue({ status: "ok", data: duplicateFiles.map((f) => f.path) });
    render(<RecentPopupsOverlay />);
    act(() => showRecentPopup("files"));
    await tick();
    return screen.getByLabelText("Filter recent files");
  }
  const options = () => within(screen.getByRole("listbox", { name: "Recent files" })).getAllByRole("option");
  afterEach(() => vi.restoreAllMocks());

  it("extends and shrinks a keyboard range, then opens its files in order", async () => {
    const input = await showFiles();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    expect(options().filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "Enter" });
    await tick();
    expect(vi.mocked(openLocation).mock.calls.map((c) => c[0])).toEqual([
      "/p/one/index.ts",
      "/p/two/index.ts",
      "/p/one/index.ts",
    ]);
    expect(useRecentPopup.getState().open).toBeNull();
  });

  it("starts a range at the initially selected previous file", async () => {
    vi.spyOn(contributions, "maybeEditorService").mockReturnValue({
      activePath: () => "/p/one/index.ts",
    } as import("@/workbench/contributions").EditorService);
    const input = await showFiles();
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    expect(options()[0]).toHaveAttribute("aria-selected", "false");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
  });

  it("handles modifier clicks and resets on filter text changes", async () => {
    const input = await showFiles();
    const click = (i: number, modifiers: object) => {
      fireEvent.mouseDown(options()[i]!, modifiers);
      fireEvent.click(options()[i]!, modifiers);
    };
    click(2, { shiftKey: true });
    expect(options().filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(3);
    click(1, { metaKey: true });
    expect(options().filter((r) => r.getAttribute("aria-selected") === "true")).toEqual([options()[0], options()[2]]);
    expect(openLocation).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "index" } });
    expect(options().filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(1);
    click(1, {});
    await tick();
    expect(openLocation).toHaveBeenCalledExactlyOnceWith("/p/two/index.ts", null, { side: false });
  });
});

describe("Find in Files dialog", () => {
  it("streams results and previews the replacement", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await act(() => new Promise((r) => setTimeout(r, 250)));
    expect(screen.getByText("1 match in 1 file")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "item" } });
    expect(screen.getByText("item", { ignore: "script, style, textarea" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace All" })).toBeEnabled();
  });
});
