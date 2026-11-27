import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Usage, UsageSearch } from "./usages";

const save = vi.fn(async (_options?: unknown): Promise<string | null> => "/tmp/usages.txt");
const writeDesktopText = vi.fn(async (_path: string, _text: string) => {});
const notify = vi.fn();
vi.mock(import("@/platform/dialog"), async (importOriginal) => ({ ...(await importOriginal()), save }));
vi.mock(import("@/platform/desktopFiles"), async (importOriginal) => ({
  ...(await importOriginal()),
  writeDesktopText,
}));
vi.mock(import("@/workbench/contributions"), async (importOriginal) => ({
  ...(await importOriginal()),
  notifications: () => ({ notify }) as never,
}));
vi.mock(import("@/platform/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commands: { fsReadText: (path: string) => path } as never,
  call: (async () => "") as never,
}));
vi.mock(import("@/editor/api"), async (importOriginal) => ({ ...(await importOriginal()), editorsFor: () => [] }));

const { UsagesView, canExportUsages, exportUsagesToTextFile, usagesReportText } = await import("./UsagesView");
const { useUsages } = await import("./usages");
const { useUsageAccessOptions } = await import("./UsageAccessFilter");
const { useProject } = await import("@/platform/project");

const ALL = { read: true, write: true };
const usage = (path: string, line: number, text: string, access?: Usage["access"]): Usage => ({
  path,
  line,
  col: text.indexOf("total"),
  endCol: text.indexOf("total") + 5,
  text,
  access,
});

function search(over: Partial<UsageSearch> = {}): UsageSearch {
  return {
    id: 7,
    symbol: "total",
    loading: false,
    error: null,
    note: null,
    rerun: null,
    scope: "project",
    groups: [
      {
        path: "/p/src/cart/cart.ts",
        usages: [
          usage("/p/src/cart/cart.ts", 11, "    return total;", "read"),
          usage("/p/src/cart/cart.ts", 3, "total = 0;", "write"),
        ],
      },
      { path: "/p/main.ts", usages: [usage("/p/main.ts", 0, "print(total)", "read")] },
    ],
    ...over,
  };
}

function show(s: UsageSearch | null) {
  useUsages.setState({ tabs: s ? [s] : [], active: s?.id ?? null });
}

afterEach(() => {
  show(null);
  useProject.setState({ project: null });
  useUsageAccessOptions.setState(ALL);
  save.mockClear();
  writeDesktopText.mockReset();
  notify.mockClear();
});

describe("usagesReportText", () => {
  it("writes the tree as shown: title, summary, files with their folder and 1-based lines", () => {
    expect(usagesReportText(search(), "/p", ALL, new Set())).toBe(
      [
        "Usages of 'total' in Project Files",
        "Found usages  (3 results)",
        "    cart.ts  src/cart  (2 usages)",
        "        12  return total;",
        "        4  total = 0;",
        "    main.ts  (1 usage)",
        "        1  print(total)",
        "",
      ].join("\n"),
    );
  });

  it("follows the tab's title for each scope", () => {
    const first = (s: UsageSearch) => usagesReportText(s, "/p", ALL, new Set()).split("\n")[0];
    expect(first(search({ scope: "libraries" }))).toBe("Usages of 'total' in Project and Libraries");
    expect(first(search({ scope: null }))).toBe("Usages of 'total'");
    expect(first(search({ symbol: null }))).toBe("Usages");
  });

  it("applies the access filter and drops files it empties", () => {
    const text = usagesReportText(search(), "/p", { read: false, write: true }, new Set());
    expect(text).toBe(
      [
        "Usages of 'total' in Project Files",
        "Found usages  (1 result)",
        "    cart.ts  src/cart  (1 usage)",
        "        4  total = 0;",
        "",
      ].join("\n"),
    );
  });

  it("keeps the summary's note", () => {
    expect(usagesReportText(search({ note: "Partial results" }), "/p", ALL, new Set()).split("\n")[1]).toBe(
      "Found usages  (3 results)  Partial results",
    );
  });

  it("writes only the summary when nothing is left", () => {
    expect(usagesReportText(search({ groups: [] }), "/p", ALL, new Set())).toBe(
      "Usages of 'total' in Project Files\nFound usages  (0 results)\n",
    );
  });
});

describe("exportUsagesToTextFile", () => {
  it("saves the active search to the picked file, named after the tab", async () => {
    useProject.setState({ project: { root: "/p" } as never });
    show(search());
    expect(canExportUsages()).toBe(true);
    await exportUsagesToTextFile();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "Usages of 'total' in Project Files.txt",
        filters: [{ name: "Text file", extensions: ["txt"] }],
      }),
    );
    expect(writeDesktopText).toHaveBeenCalledWith("/tmp/usages.txt", usagesReportText(search(), "/p", ALL, new Set()));
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves out excluded usages and files whose usages are all excluded", async () => {
    useProject.setState({ project: { root: "/p" } as never });
    // Exclusions are kept per tab id: a fresh id keeps them out of the other tests.
    show(search({ id: 8 }));
    const view = render(<UsagesView />);
    const tree = screen.getByRole("tree", { name: "Usages" });
    fireEvent.mouseDown(screen.getByRole("treeitem", { name: "1print(total)" }));
    fireEvent.keyDown(tree, { key: "Backspace" });
    fireEvent.mouseDown(screen.getByRole("treeitem", { name: "4total = 0;" }));
    fireEvent.keyDown(tree, { key: "Delete" });
    await act(() => exportUsagesToTextFile());
    expect(writeDesktopText.mock.calls[0]?.[1]).toBe(
      [
        "Usages of 'total' in Project Files",
        "Found usages  (1 result)",
        "    cart.ts  src/cart  (1 usage)",
        "        12  return total;",
        "",
      ].join("\n"),
    );
    view.unmount();
  });

  it("writes nothing when the dialog is cancelled", async () => {
    show(search());
    save.mockResolvedValueOnce(null);
    await exportUsagesToTextFile();
    expect(writeDesktopText).not.toHaveBeenCalled();
  });

  it("reports a failed write", async () => {
    show(search());
    writeDesktopText.mockRejectedValueOnce(new Error("disk full"));
    await exportUsagesToTextFile();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Cannot export the usages", body: "disk full" }),
    );
  });

  it("is unavailable while searching, without a search, or when the filter hides every usage", async () => {
    expect(canExportUsages()).toBe(false);
    show(search({ loading: true }));
    expect(canExportUsages()).toBe(false);
    show(search({ groups: [{ path: "/p/a.ts", usages: [usage("/p/a.ts", 0, "total = 1", "write")] }] }));
    useUsageAccessOptions.setState({ read: true, write: false });
    expect(canExportUsages()).toBe(false);
    await exportUsagesToTextFile();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("toolbar", () => {
  it("runs the export action", async () => {
    const { activate } = await import("./index");
    const { setContext } = await import("@/platform/context");
    const dispose = activate();
    setContext("projectOpen", true);
    setContext("activeToolWindow", "usages");
    show(search());
    const view = render(<UsagesView />);
    fireEvent.click(screen.getByRole("button", { name: "Export to Text File…" }));
    await vi.waitFor(() => expect(writeDesktopText).toHaveBeenCalledTimes(1));
    view.unmount();
    dispose();
    setContext("projectOpen", false);
    setContext("activeToolWindow", null);
  });

  it("is disabled when every shown usage is excluded or filtered out", () => {
    show(search({ id: 9 }));
    const view = render(<UsagesView />);
    const button = screen.getByRole("button", { name: "Export to Text File…" });
    expect(button).toBeEnabled();
    fireEvent.mouseDown(screen.getByRole("treeitem", { name: /^Found usages/ }));
    fireEvent.keyDown(screen.getByRole("tree", { name: "Usages" }), { key: "Backspace" });
    expect(button).toBeDisabled();
    expect(canExportUsages()).toBe(false);
    act(() => show(search({ groups: [{ path: "/p/a.ts", usages: [usage("/p/a.ts", 0, "total = 1", "write")] }] })));
    act(() => useUsageAccessOptions.setState({ read: true, write: false }));
    expect(screen.getByRole("button", { name: "Export to Text File…" })).toBeDisabled();
    view.unmount();
  });

  it("has Export to Text File, disabled while the search runs", () => {
    show(search({ loading: true }));
    const view = render(<UsagesView />);
    expect(screen.getByRole("button", { name: "Export to Text File…" })).toBeDisabled();
    act(() => show(search()));
    expect(screen.getByRole("button", { name: "Export to Text File…" })).toBeEnabled();
    view.unmount();
  });
});
