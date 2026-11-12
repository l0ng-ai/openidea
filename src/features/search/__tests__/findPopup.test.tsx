import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FileMatches, SearchSummary } from "@/platform/ipc";
import type { ReplaceRequest } from "../find/replaceFlow";

const replaced: ReplaceRequest[] = [];
const confirms: unknown[] = [];
let validation: Promise<void> | null = null;
let search: ((onFile: (file: FileMatches) => void) => Promise<SearchSummary | null>) | null = null;
let confirmation: Promise<boolean> | null = null;

vi.mock("../find/windowStore", async (orig) => ({
  ...(await orig<typeof import("../find/windowStore")>()),
  ipcFindDeps: () => ({
    validate: async () => {
      await validation;
    },
    start: async (_id: number, _q: unknown, onFile: (f: FileMatches) => void) => {
      if (search) return search(onFile);
      onFile({
        path: "/p/a.kt",
        relPath: "a.kt",
        matches: [
          { line: 1, text: "val order = 1", ranges: [[4, 9]], textOffset: 0 },
          { line: 4, text: "order()", ranges: [[0, 5]], textOffset: 0 },
        ],
      });
      onFile({
        path: "/p/b.kt",
        relPath: "b.kt",
        matches: [{ line: 0, text: "// order", ranges: [[3, 8]], textOffset: 0 }],
      });
      return null;
    },
    cancel: () => {},
    nextRequestId: () => 1,
  }),
}));
vi.mock("../find/replaceFlow", async (orig) => ({
  ...(await orig<typeof import("../find/replaceFlow")>()),
  startReplace: (r: ReplaceRequest) => {
    replaced.push(r);
    const replacements = r.targets.reduce((n, t) => n + (t.only?.length ?? 0), 0);
    return {
      result: Promise.resolve({ files: r.targets.length, replacements, failed: 0, cancelled: false, elapsedMs: 0 }),
      cancel: () => {},
    };
  },
}));
vi.mock("@/workbench/messages", async (orig) => ({
  ...(await orig<typeof import("@/workbench/messages")>()),
  confirm: async (opts: unknown) => {
    confirms.push(opts);
    return confirmation ?? true;
  },
}));

const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (o: unknown) => dialogOpen(o) }));
vi.mock("@/platform/ipc", async (orig) => ({
  ...(await orig<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
}));

const { emitLocalIdeEvent } = await import("@/platform/ipc");
const { FindInFilesOverlay } = await import("../find/FindInFiles");
const {
  findHistory,
  hideFindPopup,
  rememberFindString,
  runFindPopupCommand,
  showFindPopup,
  useFindPopup,
  useProjectMasks,
} = await import("../find/store");

const { formatBinding } = await import("@/platform/keymap");
const { usePlatform } = await import("@/platform/platformInfo");

const settle = () => act(() => new Promise((r) => setTimeout(r, 250)));
const selectedRows = () =>
  within(screen.getByRole("listbox", { name: "Matches" }))
    .getAllByRole("option")
    .filter((o) => o.getAttribute("aria-selected") === "true");
const field = () => screen.getByLabelText("Text to find");

beforeEach(() => {
  replaced.length = 0;
  confirms.length = 0;
  localStorage.clear();
  validation = null;
  search = null;
  confirmation = null;
  useFindPopup.setState({
    pattern: "",
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    scopeTab: "project",
    mask: "",
    pinned: false,
    maskEnabled: false,
    preserveCase: false,
    context: "any",
    replacement: "",
    newTab: false,
  });
});

afterEach(() => {
  act(() => hideFindPopup());
});

describe("Find in Files popup", () => {
  it("reruns the current search once when ignore rules change", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    await settle();
    expect(screen.getByRole("listbox", { name: "Matches" })).toHaveTextContent("a.kt");
    const run = vi.fn(async () => null);
    search = run;
    act(() => emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed: [], ignoreRules: ["/p"] }));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("a.kt")).not.toBeInTheDocument();
  });

  it("⇧↓ extends the selection; ↵ in Replace mode replaces the selected rows", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await settle();
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "item" } });
    fireEvent.keyDown(field(), { key: "ArrowDown", shiftKey: true });
    expect(selectedRows()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Replace 2 Occurrences" })).toBeEnabled();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.targets).toEqual([
      {
        path: "/p/a.kt",
        only: [
          { line: 1, col: 4 },
          { line: 4, col: 0 },
        ],
      },
    ]);
    // The next row still to replace is selected.
    expect(selectedRows().map((o) => o.textContent)).toEqual([expect.stringContaining("b.kt")]);
  });

  it("⌘-click toggles rows into the selection", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    await settle();
    const options = within(screen.getByRole("listbox", { name: "Matches" })).getAllByRole("option");
    fireEvent.click(options[2]!, { metaKey: true, ctrlKey: true, detail: 1 });
    expect(selectedRows()).toHaveLength(2);
    fireEvent.click(options[1]!, { detail: 1 });
    expect(selectedRows()).toHaveLength(1);
  });

  it("⇧⌥↵ replaces all, asking first only when several files are affected", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await settle();
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true, altKey: true });
    await settle();
    expect(confirms).toHaveLength(1);
    expect(replaced[0]!.targets.map((t) => t.path)).toEqual(["/p/a.kt", "/p/b.kt"]);
  });

  it("⌥ mnemonics toggle Preserve Case and the file mask", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await settle();
    fireEvent.keyDown(field(), { key: "é", code: "KeyE", altKey: true });
    expect(useFindPopup.getState().preserveCase).toBe(true);
    fireEvent.keyDown(field(), { key: "k", code: "KeyK", altKey: true });
    expect(useFindPopup.getState().maskEnabled).toBe(true);
  });

  it("the pin is a remembered toggle that keeps the popup open when a result is opened", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    await settle();
    const pin = screen.getByRole("button", { name: "Pin Window" });
    fireEvent.click(pin);
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("openidea.search.findPinned.v1")).toBe("true");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(useFindPopup.getState().open).toBe(true);
    expect(screen.getByRole("button", { name: "Open in Find Window" })).toBeInTheDocument();
  });

  it("find-next keys move the selection and ⌥↓ lists recent searches", async () => {
    rememberFindString("find", "older");
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    await settle();
    act(() => void runFindPopupCommand("nextResult"));
    act(() => void runFindPopupCommand("nextResult"));
    expect(selectedRows()[0]!.textContent).toContain("b.kt");
    act(() => void runFindPopupCommand("previousResult"));
    expect(selectedRows()[0]!.textContent).toContain("a.kt");
    act(() => void runFindPopupCommand("recentSearches"));
    expect(await screen.findByText("older")).toBeInTheDocument();
    act(() => hideFindPopup());
  });

  it("the Directory scope's browse button picks the folder, starting at the current one", async () => {
    dialogOpen.mockResolvedValue("/p/src/main");
    useFindPopup.setState({ scopeTab: "directory", directory: "/p/src" });
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await settle();
    expect(dialogOpen).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/p/src" }));
    expect(useFindPopup.getState().directory).toBe("/p/src/main");
  });

  it("closing remembers the search text", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    await settle();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(useFindPopup.getState().open).toBe(false);
    expect(findHistory("find")[0]).toBe("order");
  });
});

describe("outdated popup results", () => {
  // The results box, whether it holds the list or the empty text.
  const results = () => document.querySelector<HTMLElement>("[aria-busy]")!;
  const rowText = () =>
    within(screen.getByRole("listbox", { name: "Matches" }))
      .getAllByRole("option")
      .map((r) => r.textContent);

  it.each([false, true])(
    "marks retained rows immediately in replace=%s and waits for the first new file",
    async (replace) => {
      render(<FindInFilesOverlay />);
      act(() => showFindPopup(replace, { query: "order" }));
      await settle();
      if (replace) fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "item" } });
      const oldRows = within(screen.getByRole("listbox", { name: "Matches" })).getAllByRole("option");
      let validate!: () => void;
      validation = new Promise<void>((r) => {
        validate = r;
      });
      let onFile!: (file: FileMatches) => void;
      let finish!: (summary: SearchSummary | null) => void;
      search = (callback) => {
        onFile = callback;
        return new Promise((r) => {
          finish = r;
        });
      };
      fireEvent.change(field(), { target: { value: "fresh" } });
      expect(results()).toHaveAttribute("data-stale", "true");
      expect(screen.getByText("Updating results…")).toBeInTheDocument();
      expect(within(results()).getAllByRole("option")).toEqual(oldRows);
      expect(results().querySelector("mark, del, ins")).toBeNull();
      expect(screen.queryByText("3 matches in 2 files")).not.toBeInTheDocument();
      await settle();
      expect(results()).toHaveAttribute("data-stale", "true");
      expect(rowText()).toHaveLength(3);
      await act(async () => validate());
      expect(results()).toHaveAttribute("data-stale", "true");
      expect(rowText()).toHaveLength(3);
      if (replace) expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
      await act(async () =>
        onFile({
          path: "/p/fresh.kt",
          relPath: "fresh.kt",
          matches: [{ line: 0, text: "fresh", ranges: [[0, 5]], textOffset: 0 }],
        }),
      );
      expect(results()).not.toHaveAttribute("data-stale");
      expect(rowText()).toHaveLength(1);
      expect(screen.getByText("1 match in 1 file")).toBeInTheDocument();
      expect(results().querySelector("mark")).not.toBeNull();
      expect(results().querySelector("del, ins")).toBeNull();
      if (replace) expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
      await act(async () => finish(null));
    },
  );

  it.each(["Replace", "Replace All", "Enter", "All shortcut", "All mnemonic"])(
    "blocks %s during debounce and validation",
    async (action) => {
      render(<FindInFilesOverlay />);
      act(() => showFindPopup(true, { query: "order" }));
      await settle();
      validation = new Promise(() => {});
      fireEvent.change(field(), { target: { value: "ord" } });
      const invoke = () => {
        if (action === "Enter") fireEvent.keyDown(field(), { key: "Enter" });
        else if (action === "All shortcut") fireEvent.keyDown(field(), { key: "Enter", altKey: true, shiftKey: true });
        else if (action === "All mnemonic") fireEvent.keyDown(field(), { key: "a", code: "KeyA", altKey: true });
        else {
          const button = screen.getByRole("button", { name: action });
          expect(button).toBeDisabled();
          fireEvent.click(button);
        }
      };
      invoke();
      await settle();
      invoke();
      await act(async () => {});
      expect(replaced).toHaveLength(0);
      expect(confirms).toHaveLength(0);
    },
  );

  it.each([
    { caseSensitive: true },
    { wholeWord: true },
    { isRegex: true },
    { maskEnabled: true, mask: "*.ts" },
    { scopeTab: "directory" as const, directory: "/other" },
    { context: "inComments" as const },
  ])("invalidates when search options change: %j", async (patch) => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await settle();
    act(() => useFindPopup.setState(patch));
    expect(results()).toHaveAttribute("data-stale", "true");
    expect(results().querySelector("mark, del, ins")).toBeNull();
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
  });

  it("clears retained rows and the count when the new search finds nothing", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await settle();
    let finish!: (summary: SearchSummary | null) => void;
    search = () =>
      new Promise((r) => {
        finish = r;
      });
    fireEvent.change(field(), { target: { value: "absent" } });
    await settle();
    expect(results()).toHaveAttribute("data-stale", "true");
    expect(rowText()).toHaveLength(3);
    await act(async () => finish(null));
    expect(results()).not.toHaveAttribute("data-stale");
    // IDEA's header shows a count only while something matches.
    expect(screen.queryByText(/\bmatch(es)? in\b/)).not.toBeInTheDocument();
    expect(screen.getByText("Nothing found")).toBeInTheDocument();
    expect(within(results()).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
  });

  it.each([false, true])("keeps opening an outdated result available in replace=%s", async (replace) => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(replace, { query: "order" }));
    await settle();
    fireEvent.change(field(), { target: { value: "absent" } });
    if (replace) act(() => void runFindPopupCommand("openResult"));
    else fireEvent.keyDown(field(), { key: "Enter" });
    expect(useFindPopup.getState().open).toBe(false);
    expect(replaced).toHaveLength(0);
  });

  it("rejects Replace All if the query changes while confirmation is open", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(true, { query: "order" }));
    await settle();
    let confirm!: (ok: boolean) => void;
    confirmation = new Promise((r) => {
      confirm = r;
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace All" }));
    expect(confirms).toHaveLength(1);
    fireEvent.change(field(), { target: { value: "ord" } });
    await settle();
    await act(async () => confirm(true));
    expect(replaced).toHaveLength(0);
  });
});

describe("footer, as IDEA", () => {
  it("remembers Open results in new tab and passes it on; ⌥B toggles it", () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    const box = screen.getByRole("checkbox", { name: "Open results in new tab" });
    expect(box).not.toBeChecked();
    fireEvent.keyDown(field(), { key: "b", code: "KeyB", altKey: true });
    expect(box).toBeChecked();
    expect(localStorage.getItem("openidea.search.findNewTab.v1")).toBe("true");
    fireEvent.click(box);
    expect(useFindPopup.getState().newTab).toBe(false);
  });

  it("keeps OpenIDEA's Replace preview: a diff in place of the code preview", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    expect(screen.queryByRole("checkbox", { name: "Preview" })).not.toBeInTheDocument();
    act(() => showFindPopup(true, { query: "order" }));
    await settle();
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Preview" }));
    expect(screen.queryByRole("region", { name: "Preview" })).not.toBeInTheDocument();
  });

  it("names the result keys only for a multi-line query", () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "order" }));
    expect(screen.queryByText(/to select usages$/)).not.toBeInTheDocument();
    fireEvent.change(field(), { target: { value: "order\nitem" } });
    expect(screen.getByText(/^Use .+ and .+ to select usages$/)).toBeInTheDocument();
  });
});

describe("mnemonics, as IDEA", () => {
  it("⌥P / ⌥M / ⌥D / ⌥S pick the scope tab, whose letter is underlined off macOS", () => {
    const os = usePlatform.getState().os;
    usePlatform.setState({ os: "linux" });
    try {
      render(<FindInFilesOverlay />);
      act(() => showFindPopup(false, { query: "order" }));
      expect(screen.getByRole("tab", { name: "In Project" }).querySelector("u")?.textContent).toBe("P");
      for (const [code, tab] of [
        ["KeyD", "directory"],
        ["KeyS", "scope"],
        ["KeyM", "module"],
        ["KeyP", "project"],
      ] as const) {
        fireEvent.keyDown(field(), { key: code.slice(3).toLowerCase(), code, altKey: true });
        expect(useFindPopup.getState().scopeTab).toBe(tab);
      }
    } finally {
      usePlatform.setState({ os });
    }
  });
});

describe("file mask, as IDEA", () => {
  it("turned on with nothing typed takes the first suggestion", () => {
    useProjectMasks.setState({ masks: ["*.rs", "*.toml"] });
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false));
    expect(screen.getByLabelText("File mask")).toHaveAttribute("placeholder", "*.rs");
    fireEvent.click(screen.getByRole("checkbox", { name: "File mask:" }));
    expect([useFindPopup.getState().maskEnabled, useFindPopup.getState().mask]).toEqual([true, "*.rs"]);
  });
});

describe("layout, as IDEA", () => {
  it("shows the preview only once something matches", async () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false));
    expect(screen.queryByRole("region", { name: "Preview" })).not.toBeInTheDocument();
    fireEvent.change(field(), { target: { value: "order" } });
    await settle();
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
  });

  it("is resizable and opens at the size it was left at", () => {
    localStorage.setItem("openidea.search.findPopupSize.v1", JSON.stringify({ w: 700, h: 520 }));
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false));
    const dialog = screen.getByRole("dialog");
    expect([dialog.style.width, dialog.style.height]).toEqual(["700px", "520px"]);
    expect(within(dialog).getByRole("separator", { name: "Resize" })).toBeInTheDocument();
  });
});

describe("empty results, as IDEA", () => {
  const findNothing = () => {
    search = async () => null;
  };

  it("asks for a query while there is none", () => {
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false));
    expect(screen.getByText("Type search query to find in files")).toBeInTheDocument();
  });

  it("names the one option in use and clears it", () => {
    useFindPopup.setState({ maskEnabled: true, mask: "*.rs" });
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false));
    expect(screen.getByText("No search text entered.")).toBeInTheDocument();
    expect(screen.getByText("Search option used: File mask")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear option" }));
    expect(useFindPopup.getState().maskEnabled).toBe(false);
    expect(screen.getByText("Type search query to find in files")).toBeInTheDocument();
  });

  it("lists every option in use with its key, and ⇧⌥⌫ clears them all", async () => {
    findNothing();
    useFindPopup.setState({ caseSensitive: true, wholeWord: true, context: "inComments" });
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "absent" }));
    await settle();
    expect(screen.getByText("Nothing found.")).toBeInTheDocument();
    expect(screen.getByText("Search options used:")).toBeInTheDocument();
    expect(
      screen.getByText(`Match Case ${formatBinding("Alt+C")} Words ${formatBinding("Alt+W")} Filter`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all options" })).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Backspace", altKey: true, shiftKey: true });
    const s = useFindPopup.getState();
    expect([s.caseSensitive, s.wholeWord, s.isRegex, s.maskEnabled, s.context]).toEqual([
      false,
      false,
      false,
      false,
      "any",
    ]);
  });

  it("offers Search with Regex for a query that reads as one", async () => {
    findNothing();
    render(<FindInFilesOverlay />);
    act(() => showFindPopup(false, { query: "fo+.*bar" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Search with Regex" }));
    expect(useFindPopup.getState().isRegex).toBe(true);
  });
});
