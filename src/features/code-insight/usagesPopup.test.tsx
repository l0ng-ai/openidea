import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const calls: string[] = [];
/** The editor at the caret (`null`: none, as for a search from outside an editor). */
let caretView: import("@codemirror/view").EditorView | null = null;
const referenceResponse = vi.fn(
  async (): Promise<{ locations: (typeof loc)[]; incomplete: null; librariesSkipped?: boolean }> => ({
    locations: [loc],
    incomplete: null,
  }),
);
const loc = { path: "/p/b.ts", range: { start: { line: 1, col: 4 }, end: { line: 1, col: 8 } } };
const lspReferences = vi.fn(async () => ({ status: "ok", data: null }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, lspReferences } };
});
vi.mock("@/platform/keymap", async (orig) => ({
  ...(await orig<typeof import("@/platform/keymap")>()),
  shortcutLabel: (id: string) => (id === "find.showUsages" ? "⌥⌘F7" : ""),
}));
vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  caretContext: () => ({ doc: 1, path: "/p/a.ts", line: 0, col: 0, word: "used", view: caretView }),
  lspRequest: (request: () => unknown) => {
    request();
    return referenceResponse();
  },
  readManyFileLines: async () => new Map([["/p/b.ts", ["", "    used();"]]]),
  openLocation: async (path: string, line: number) => void calls.push(`open ${path}:${line}`),
  hint: (text: string) => void calls.push(`hint ${text}`),
}));
/** The partial-results channels of the searches, newest last. */
const channels: { onmessage: (refs: unknown) => void }[] = [];
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
    constructor() {
      channels.push(this);
    }
  },
}));
const showUsageResults = vi.fn();
vi.mock("./usages", async (orig) => ({
  ...(await orig<typeof import("./usages")>()),
  showUsageResults: (a: unknown) => showUsageResults(a),
}));

const { UsagesPopup, filterUsages, usageLocations } = await import("./UsagesPopup");
const { showUsagesPopup, useUsagesPopup, dismissUsagesPopup, setUsagesPopupScope } = await import("./usages");

const usage = (path: string, line: number, text: string) => ({ path, line, col: 0, endCol: 3, text });
const groups = [
  { path: "/p/a.ts", usages: [usage("/p/a.ts", 2, "foo(order)"), usage("/p/a.ts", 5, "foo(cart)")] },
  { path: "/p/b.ts", usages: [usage("/p/b.ts", 1, "foo(order, 2)")] },
];

function open() {
  render(<UsagesPopup />);
  act(() => useUsagesPopup.setState({ open: true, anchor: { x: 0, y: 0 }, symbol: "foo", groups, note: null }));
  return screen.getByRole("dialog", { name: "Usages" }).querySelector<HTMLElement>("[tabindex='0']")!;
}

const { useUsageAccessOptions } = await import("./UsageAccessFilter");
afterEach(() =>
  act(() => {
    dismissUsagesPopup();
    useUsageAccessOptions.setState({ read: true, write: true });
    localStorage.removeItem("openidea.usages.accessFilter.v1");
  }),
);

describe("Show Usages popup", () => {
  it("filters by typing; Esc clears the filter, then closes", () => {
    const body = open();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    for (const key of "cart") fireEvent.keyDown(body, { key });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("1 of 3 found")).toBeInTheDocument();
    fireEvent.keyDown(body, { key: "Escape" });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(useUsagesPopup.getState().open).toBe(true);
    fireEvent.keyDown(body, { key: "Escape" });
    expect(useUsagesPopup.getState().open).toBe(false);
  });

  it("matches file names and line text", () => {
    const all = groups.flatMap((g) => g.usages);
    expect(filterUsages(all, "b.ts")).toHaveLength(1);
    expect(filterUsages(all, "ORDER")).toHaveLength(2);
    expect(filterUsages(all, "")).toBe(all);
  });

  it("Open in Find Window moves the found usages instead of searching again", () => {
    open();
    fireEvent.click(screen.getByText(/Open in Find Window/));
    expect(useUsagesPopup.getState().open).toBe(false);
    expect(showUsageResults).toHaveBeenCalledWith({
      symbol: "foo",
      note: null,
      classified: expect.arrayContaining([expect.objectContaining({ kind: "unknown" })]),
      locations: [
        { path: "/p/a.ts", range: { start: { line: 2, col: 0 }, end: { line: 2, col: 3 } } },
        { path: "/p/a.ts", range: { start: { line: 5, col: 0 }, end: { line: 5, col: 3 } } },
        { path: "/p/b.ts", range: { start: { line: 1, col: 0 }, end: { line: 1, col: 3 } } },
      ],
    });
  });

  it("the preview pane toggles", () => {
    open();
    expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Preview" }));
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show Preview" }));
  });

  it("a single usage is opened with a hint in its editor", async () => {
    calls.length = 0;
    await showUsagesPopup();
    expect(calls).toEqual(["open /p/b.ts:1", "hint Only one usage in Project Files"]);
    expect(useUsagesPopup.getState().open).toBe(false);
  });
});

describe("semantic usage categories", () => {
  it("separates calls on the same line and preserves categories when opening the Find window", () => {
    open();
    const text = "b.setName(b.getName())";
    act(() =>
      useUsagesPopup.setState({
        groups: [
          {
            path: "/p/Bean.java",
            usages: [
              { path: "/p/Bean.java", line: 2, col: 2, endCol: 9, text, kind: "setter", access: "write" },
              { path: "/p/Bean.java", line: 2, col: 12, endCol: 19, text, kind: "getter", access: "read" },
              { path: "/p/Bean.java", line: 3, col: 0, endCol: 4, text: "name", kind: "field", access: "readWrite" },
              { path: "/p/Bean.java", line: 4, col: 0, endCol: 4, text: "other" },
            ],
          },
        ],
      }),
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show write accesses" }));
    expect(screen.getByText("3 of 4 found")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show read accesses" }));
    expect(screen.getByRole("button", { name: "Show write accesses" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("3 of 4 found")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Open in Find Window/));
    expect(showUsageResults).toHaveBeenLastCalledWith(
      expect.objectContaining({
        classified: expect.arrayContaining([
          expect.objectContaining({ kind: "getter", access: "read" }),
          expect.objectContaining({ kind: "setter", access: "write" }),
          expect.objectContaining({ kind: "field", access: "readWrite" }),
          expect.objectContaining({ kind: "unknown" }),
        ]),
      }),
    );
  });
});

it("keeps unknown results visible after classified results are replaced", () => {
  open();
  act(() =>
    useUsagesPopup.setState({
      groups: [
        { path: "/Bean.java", usages: [{ ...usage("/Bean.java", 1, "getName()"), kind: "getter", access: "read" }] },
      ],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show write accesses" }));
  act(() => useUsagesPopup.setState({ groups }));
  expect(screen.queryByRole("toolbar", { name: "Usage access filters" })).toBeNull();
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

it("preserves an exact multiline semantic range when transferring to Find", () => {
  const sourceLocation = { path: "/Bean.java", range: { start: { line: 1, col: 0 }, end: { line: 2, col: 10 } } };
  expect(
    usageLocations([{ path: "/Bean.java", usages: [{ ...usage("/Bean.java", 1, "b.value()"), sourceLocation }] }]),
  ).toEqual([sourceLocation]);
});

it("does not reopen after dismissal or let a superseded response replace a newer popup", async () => {
  const result = {
    locations: [loc, { ...loc, range: { start: { line: 2, col: 0 }, end: { line: 2, col: 4 } } }],
    incomplete: null,
  };
  let oldResolve!: (value: typeof result) => void;
  referenceResponse.mockReturnValueOnce(
    new Promise((resolve) => {
      oldResolve = resolve;
    }),
  );
  const old = showUsagesPopup();
  const fresh = showUsagesPopup();
  await fresh;
  dismissUsagesPopup();
  oldResolve(result);
  await old;
  expect(useUsagesPopup.getState().open).toBe(false);
});

it("keeps filter controls available when all classified rows are hidden", () => {
  open();
  act(() =>
    useUsagesPopup.setState({
      groups: [
        {
          path: "/Bean.java",
          usages: [
            { ...usage("/Bean.java", 1, "b.count"), access: "read" },
            { ...usage("/Bean.java", 2, "b.count"), access: "read" },
          ],
        },
      ],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show read accesses" }));
  expect(screen.getByText("No usages match the access filters")).toBeInTheDocument();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Show read accesses" }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
});

it("opens with the usages found first and fills in the rest", async () => {
  render(<UsagesPopup />);
  const at = (line: number) => ({ ...loc, range: { start: { line, col: 4 }, end: { line, col: 8 } } });
  let resolve!: (value: { locations: (typeof loc)[]; incomplete: null }) => void;
  referenceResponse.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const before = calls.length;
  const requested = lspReferences.mock.calls.length;
  const pending = showUsagesPopup();
  await act(async () => {
    await vi.waitFor(() => expect(lspReferences).toHaveBeenCalledTimes(requested + 1));
    channels.at(-1)!.onmessage({ locations: [at(1)], incomplete: null });
  });
  // Not before the rest had a moment to arrive.
  expect(useUsagesPopup.getState().open).toBe(false);
  await act(() => new Promise((r) => setTimeout(r, 350)));
  expect(useUsagesPopup.getState()).toMatchObject({ open: true, loading: true });
  expect(screen.getByRole("status", { name: "Searching for more usages" })).toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await act(async () => channels.at(-1)!.onmessage({ locations: [at(1), at(2)], incomplete: null }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await act(async () => {
    resolve({ locations: [at(1), at(2), at(3)], incomplete: null });
    await pending;
  });
  expect(useUsagesPopup.getState()).toMatchObject({ open: true, loading: false });
  expect(screen.queryByRole("status", { name: "Searching for more usages" })).toBeNull();
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(calls.slice(before)).toEqual([]);
  act(() => dismissUsagesPopup());
});

it("says at the caret that it is searching until the popup shows", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { PENDING_HINT_DELAY_MS } = await import("@/editor/lsp/hint");
  render(<UsagesPopup />);
  caretView = new EditorView({ state: EditorState.create({ doc: "used();" }), parent: document.body });
  const hint = () => document.querySelector(".cm-lsp-hint")?.textContent ?? null;
  const at = (line: number) => ({ ...loc, range: { start: { line, col: 4 }, end: { line, col: 8 } } });
  let resolve!: (value: { locations: (typeof loc)[]; incomplete: null }) => void;
  referenceResponse.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  try {
    const pending = showUsagesPopup();
    expect(hint()).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, PENDING_HINT_DELAY_MS + 10)));
    expect(hint()).toBe("Searching for usages…");
    await act(async () => {
      resolve({ locations: [at(1), at(2)], incomplete: null });
      await pending;
    });
    expect(useUsagesPopup.getState().open).toBe(true);
    expect(hint()).toBeNull();
  } finally {
    caretView.destroy();
    caretView = null;
    act(() => dismissUsagesPopup());
  }
});

it("jumps to a single usage when all arrive quickly, and otherwise stays open", async () => {
  render(<UsagesPopup />);
  let resolve!: (value: { locations: (typeof loc)[]; incomplete: null }) => void;
  const respond = () =>
    referenceResponse.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
  respond();
  let before = calls.length;
  let requested = lspReferences.mock.calls.length;
  let pending = showUsagesPopup();
  await act(async () => {
    await vi.waitFor(() => expect(lspReferences).toHaveBeenCalledTimes(requested + 1));
    channels.at(-1)!.onmessage({ locations: [loc], incomplete: null });
  });
  await act(async () => {
    resolve({ locations: [loc], incomplete: null });
    await pending;
  });
  expect(useUsagesPopup.getState().open).toBe(false);
  expect(calls.slice(before)).toEqual(["open /p/b.ts:1", "hint Only one usage in Project Files"]);
  respond();
  before = calls.length;
  requested = lspReferences.mock.calls.length;
  pending = showUsagesPopup();
  await act(async () => {
    await vi.waitFor(() => expect(lspReferences).toHaveBeenCalledTimes(requested + 1));
    channels.at(-1)!.onmessage({ locations: [loc], incomplete: null });
  });
  await act(() => new Promise((r) => setTimeout(r, 350)));
  await act(async () => {
    resolve({ locations: [loc], incomplete: null });
    await pending;
  });
  expect(useUsagesPopup.getState()).toMatchObject({ open: true, loading: false });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(calls.slice(before)).toEqual([]);
  act(() => dismissUsagesPopup());
});

it("searches Project Files, and Project and Libraries when invoked again", async () => {
  render(<UsagesPopup />);
  const at = (line: number) => ({ ...loc, range: { start: { line, col: 4 }, end: { line, col: 8 } } });
  const libraries = () => (lspReferences.mock.lastCall as unknown[])[5];
  const widen = "Press ⌥⌘F7 again to search in 'Project and Libraries'";
  // Nothing in Project Files: the hint offers the libraries, searched when invoked again meanwhile.
  let before = calls.length;
  referenceResponse.mockResolvedValueOnce({ locations: [], incomplete: null, librariesSkipped: true });
  await showUsagesPopup();
  expect(libraries()).toBe(false);
  expect(calls.slice(before)).toEqual([`hint No usages found in Project Files. ${widen}`]);
  referenceResponse.mockResolvedValueOnce({ locations: [at(1), at(2)], incomplete: null });
  await act(() => showUsagesPopup());
  expect(libraries()).toBe(true);
  expect(useUsagesPopup.getState()).toMatchObject({ open: true, scope: "libraries" });
  expect(screen.getByRole("button", { name: "Scope" })).toHaveTextContent("Project and Libraries");
  // The scope chooser searches Project Files again.
  referenceResponse.mockResolvedValueOnce({ locations: [at(1), at(2)], incomplete: null, librariesSkipped: true });
  await act(async () => setUsagesPopupScope("project"));
  await vi.waitFor(() => expect(useUsagesPopup.getState()).toMatchObject({ loading: false, scope: "project" }));
  expect(libraries()).toBe(false);
  expect(screen.getByRole("button", { name: "Scope" })).toHaveTextContent("Project Files");
  // Switched while Project and Libraries are still searched: that search gives way.
  let finish!: (value: { locations: (typeof loc)[]; incomplete: null }) => void;
  referenceResponse.mockReturnValueOnce(new Promise((r) => (finish = r)));
  await act(async () => setUsagesPopupScope("libraries"));
  expect(libraries()).toBe(true);
  expect(useUsagesPopup.getState()).toMatchObject({ loading: true, scope: "libraries" });
  referenceResponse.mockResolvedValueOnce({ locations: [at(1), at(2)], incomplete: null, librariesSkipped: true });
  await act(async () => setUsagesPopupScope("project"));
  await vi.waitFor(() => expect(useUsagesPopup.getState()).toMatchObject({ loading: false, scope: "project" }));
  expect(libraries()).toBe(false);
  await act(async () => finish({ locations: [at(1), at(2), at(3), at(4)], incomplete: null }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  // Invoked again while it shows Project Files: Project and Libraries.
  referenceResponse.mockResolvedValueOnce({ locations: [at(1), at(2), at(3)], incomplete: null });
  await act(() => showUsagesPopup());
  expect(libraries()).toBe(true);
  expect(screen.getAllByRole("option")).toHaveLength(3);
  act(() => dismissUsagesPopup());
  // The only usage in Project Files is opened; the hint offers the libraries too.
  before = calls.length;
  referenceResponse.mockResolvedValueOnce({ locations: [at(1)], incomplete: null, librariesSkipped: true });
  await showUsagesPopup();
  expect(calls.slice(before)).toEqual(["open /p/b.ts:1", `hint Only one usage in Project Files. ${widen}`]);
  referenceResponse.mockResolvedValueOnce({ locations: [at(1)], incomplete: null });
  before = calls.length;
  await showUsagesPopup();
  expect(libraries()).toBe(true);
  expect(calls.slice(before)).toEqual(["open /p/b.ts:1", "hint Only one usage in Project and Libraries"]);
  // Without a hint showing, it searches the symbol at the caret in Project Files again.
  referenceResponse.mockResolvedValueOnce({ locations: [at(1)], incomplete: null, librariesSkipped: true });
  await showUsagesPopup();
  expect(libraries()).toBe(false);
});

it("discards a pending response after the current popup is dismissed", async () => {
  let resolve!: (value: { locations: (typeof loc)[]; incomplete: null }) => void;
  referenceResponse.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = showUsagesPopup();
  dismissUsagesPopup();
  resolve({ locations: [loc, { ...loc, path: "/p/other.ts" }], incomplete: null });
  await pending;
  expect(useUsagesPopup.getState().open).toBe(false);
});

it("clears speed search before closing when Escape comes from an access button", () => {
  const body = open();
  act(() =>
    useUsagesPopup.setState({
      groups: groups.map((g) => ({ ...g, usages: g.usages.map((u) => ({ ...u, access: "read" as const })) })),
    }),
  );
  for (const key of "cart") fireEvent.keyDown(body, { key });
  const button = screen.getByRole("button", { name: "Show write accesses" });
  fireEvent.click(button);
  button.focus();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(useUsagesPopup.getState().open).toBe(true);
  expect(screen.getAllByRole("option")).toHaveLength(3);
  fireEvent.keyDown(button, { key: "Escape" });
  expect(useUsagesPopup.getState().open).toBe(false);
});
