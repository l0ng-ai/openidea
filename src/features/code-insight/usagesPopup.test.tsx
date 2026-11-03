import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const calls: string[] = [];
const referenceResponse = vi.fn(async () => ({ locations: [loc], incomplete: null }));
const loc = { path: "/p/b.ts", range: { start: { line: 1, col: 4 }, end: { line: 1, col: 8 } } };
vi.mock("./ipc", async (orig) => ({
  ...(await orig<typeof import("./ipc")>()),
  caretContext: () => ({ doc: 1, path: "/p/a.ts", line: 0, col: 0, word: "used", view: null }),
  lspRequest: () => referenceResponse(),
  readManyFileLines: async () => new Map([["/p/b.ts", ["", "    used();"]]]),
  openLocation: async (path: string, line: number) => void calls.push(`open ${path}:${line}`),
  hint: (text: string) => void calls.push(`hint ${text}`),
}));
const showUsageResults = vi.fn();
vi.mock("./usages", async (orig) => ({
  ...(await orig<typeof import("./usages")>()),
  showUsageResults: (a: unknown) => showUsageResults(a),
}));

const { UsagesPopup, filterUsages, usageLocations } = await import("./UsagesPopup");
const { showUsagesPopup, useUsagesPopup, dismissUsagesPopup } = await import("./usages");

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
