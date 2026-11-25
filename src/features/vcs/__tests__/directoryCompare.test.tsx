import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DirectoryCompareEntry } from "@/bindings";

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  cancel: vi.fn(),
  sync: vi.fn(),
  kind: vi.fn(),
  choose: vi.fn(),
  confirm: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsCompareDirectories: mocks.compare,
      fsSynchronizeDirectories: mocks.sync,
      fsEntryKind: mocks.kind,
      cancelRequest: mocks.cancel,
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/platform/choosePath", () => ({ choosePath: mocks.choose }));
vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: unknown }) => <div data-testid="diff">{JSON.stringify(input)}</div>,
}));
vi.mock("../dialogs", () => ({ confirmDialog: mocks.confirm, openDialog: vi.fn(), promptText: vi.fn() }));
vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff: mocks.open,
  openVcsDiff: mocks.open,
}));
import {
  DirectoryCompare,
  directoryDiff,
  directoryRows,
  syncChoices,
  syncOperations,
  type SyncAction,
} from "../DirectoryCompare";
import { directoryCompareTitle } from "../directoryCompareKind";

const row = (
  path: string,
  status: DirectoryCompareEntry["status"],
  leftKind: DirectoryCompareEntry["leftKind"] = "file",
  rightKind: DirectoryCompareEntry["rightKind"] = "file",
): DirectoryCompareEntry => ({ path, status, leftKind, rightKind });
const rows = [
  row("nested", "different", "dir", "dir"),
  row("nested/中文.txt", "different"),
  row("only-left.txt", "leftOnly", "file", null),
  row("only-right.txt", "rightOnly", null, "file"),
  row("same.txt", "equal"),
  row("empty", "leftOnly", "dir", null),
];
const ok = (data: unknown = null) => ({ status: "ok", data });
const setup = () => render(<DirectoryCompare left="/p/left" right="/p/right" />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.compare.mockResolvedValue(ok(rows));
  mocks.sync.mockResolvedValue(ok([]));
  mocks.kind.mockResolvedValue(ok("dir"));
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("disk directory comparison", () => {
  it("lays both sides out in columns, filters by status and name", async () => {
    mocks.compare.mockResolvedValue(
      ok([...rows.slice(0, 2), { ...rows[2]!, leftSize: 2048, leftModified: Date.UTC(2026, 0, 2) }, ...rows.slice(3)]),
    );
    setup();
    expect(await screen.findAllByText("中文.txt")).toHaveLength(2);
    expect(screen.getAllByRole("columnheader", { name: "Size" })).toHaveLength(2);
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^Only on left:/)).toHaveLength(2);
    expect(screen.getByLabelText("Only on right: Copy to Left")).toBeInTheDocument();
    expect(screen.queryByText("same.txt")).toBeNull();
    const identical = screen.getByRole("button", { name: "Show identical files" });
    expect(identical).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(identical);
    expect(screen.getAllByText("same.txt")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show files only on left" }));
    expect(screen.queryByText("only-left.txt")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter by name" }), { target: { value: "中文" } });
    expect(screen.queryByText("same.txt")).toBeNull();
    expect(screen.getAllByText("nested")).toHaveLength(2);
  });

  it("groups files under their folder and keeps one-sided folders whole", () => {
    const all = new Set(["leftOnly", "rightOnly", "different", "equal"] as const);
    const entries = [
      row("a.txt", "different"),
      row("dir", "different", "dir", "dir"),
      row("dir/b.txt", "different"),
      row("dir/sub", "different", "dir", "dir"),
      row("dir/sub/c.txt", "rightOnly", null, "file"),
      row("gone", "leftOnly", "dir", null),
      row("gone/inside.txt", "leftOnly", "file", null),
      row("z.txt", "equal"),
    ];
    const label = (r: ReturnType<typeof directoryRows>[number]) =>
      "section" in r ? `[${r.section}]` : r.folder ? `<${r.entry.path}>` : r.entry.path;
    expect(directoryRows(entries, all, "").map(label)).toEqual([
      "a.txt",
      "gone",
      "z.txt",
      "<dir>",
      "dir/b.txt",
      "<dir/sub>",
      "dir/sub/c.txt",
    ]);
    expect(directoryRows(entries, all, "inside").map(label)).toEqual(["gone"]);
    // A match nested deeper inside a one-sided folder still shows that folder's row (#4085).
    const nested = [
      row("only-left", "leftOnly", "dir", null),
      row("only-left/sub", "leftOnly", "dir", null),
      row("only-left/sub/nested.txt", "leftOnly", "file", null),
    ];
    expect(directoryRows(nested, new Set(["leftOnly"]), "nested.txt").map(label)).toEqual(["only-left"]);
    expect(directoryRows(entries, new Set(["rightOnly"]), "").map(label)).toEqual(["<dir/sub>", "dir/sub/c.txt"]);
  });

  it("names the tab after both folders, with their parents when the names are equal", () => {
    expect(directoryCompareTitle({ left: "/p/left", right: "/p/right/" })).toBe("left ↔ right");
    expect(directoryCompareTitle({ left: "/x/project-a/config", right: "/x/project-b/config" })).toBe(
      "project-a/config ↔ project-b/config",
    );
  });

  it("previews the selection below the table and opens the diff on double click, including missing sides", async () => {
    setup();
    fireEvent.mouseDown((await screen.findAllByText("中文.txt"))[0]!, { button: 0 });
    expect(await screen.findByTestId("diff")).toHaveTextContent("/p/left/nested/中文.txt");
    fireEvent.doubleClick(screen.getAllByText("中文.txt")[0]!);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/right/nested/中文.txt" }));
    expect(directoryDiff("/l", "/r", rows[2]!)?.right.type).toBe("text");
    expect(directoryDiff("/l", "/r", rows[3]!)?.left.type).toBe("text");
    expect(directoryDiff("/l", "/r", row("type", "different", "file", "dir"))).toBeNull();
    expect(
      directoryDiff("/l", "/r", {
        ...row("link", "different", "symlink", "symlink"),
        leftLink: "one",
        rightLink: "two",
      }),
    ).toMatchObject({
      left: { type: "text", text: "one" },
      right: { type: "text", text: "two" },
    });
  });

  it("defaults, cycles and batches per-row operations", () => {
    const entries = [rows[0]!, rows[1]!, rows[2]!, rows[3]!, rows[4]!];
    expect(entries.map((e) => syncChoices(e)[0])).toEqual(["none", "none", "copyToRight", "copyToLeft", "none"]);
    expect(syncChoices(rows[2]!)).toEqual(["copyToRight", "deleteLeft", "none"]);
    expect(syncChoices(rows[3]!)).toEqual(["copyToLeft", "deleteRight", "none"]);
    const chosen: Record<string, SyncAction> = { "nested/中文.txt": "copyToLeft", "only-right.txt": "deleteRight" };
    expect(syncOperations(entries, (e) => chosen[e.path] ?? syncChoices(e)[0]!)).toEqual([
      { path: "nested/中文.txt", action: "copyToLeft", overwrite: true },
      { path: "only-left.txt", action: "copyToRight", overwrite: false },
      { path: "only-right.txt", action: "deleteRight", overwrite: false },
    ]);
  });

  it("synchronizes the selected row or all rows after one confirmation, then refreshes", async () => {
    setup();
    const marker = async (name: string) => (await screen.findAllByRole("button", { name }))[0]!;
    // Space on the selected row and a click on its marker change the operation.
    fireEvent.mouseDown((await screen.findAllByText("中文.txt"))[0]!, { button: 0 });
    expect(screen.getByRole("button", { name: "Synchronize Selected" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("grid"), { key: " " });
    expect(await marker("Contents differ: Copy to Right")).toBeInTheDocument();
    fireEvent.click(await marker("Contents differ: Copy to Right"));
    expect(await marker("Contents differ: Copy to Left")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Synchronize Selected" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0]![0].message).toBe("Synchronize 1 entries? 0 will be deleted and 1 overwritten.");
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
    expect(mocks.sync.mock.calls[0]!.slice(0, 3)).toEqual([
      "/p/left",
      "/p/right",
      [{ path: "nested/中文.txt", action: "copyToLeft", overwrite: true }],
    ]);
    // A refresh resets the operations; only-left copies and the other one-sided row is deleted.
    fireEvent.click(await marker("Only on right: Copy to Left"));
    fireEvent.click(screen.getByRole("button", { name: "Synchronize All" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    expect(mocks.confirm.mock.calls[1]![0].message).toBe("Synchronize 3 entries? 1 will be deleted and 0 overwritten.");
    expect(mocks.sync.mock.calls[1]![2]).toEqual([
      { path: "empty", action: "copyToRight", overwrite: false },
      { path: "only-left.txt", action: "copyToRight", overwrite: false },
      { path: "only-right.txt", action: "deleteRight", overwrite: false },
    ]);
  });

  it("asks nothing for plain copies, keeps the batch when confirmation is declined and reports failures", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    setup();
    fireEvent.click((await screen.findAllByRole("button", { name: "Only on right: Copy to Left" }))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Synchronize All" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.sync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Only on right: Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Only on right: Do nothing" }));
    mocks.sync.mockResolvedValueOnce(
      ok([{ path: "only-left.txt", action: "copyToRight", message: "Permission denied" }]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Synchronize All" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only-left.txt: Permission denied");
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
  });

  it("compares by the chosen mode, recomparing and remembering it", async () => {
    localStorage.removeItem("openidea.directoryCompare.mode");
    const view = setup();
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(1));
    expect(mocks.compare.mock.calls[0]![2]).toBe("content");
    fireEvent.click(screen.getByRole("button", { name: "Compare by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Size and timestamp" }));
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
    expect(mocks.compare.mock.calls[1]![2]).toBe("sizeAndTimestamp");
    view.unmount();
    setup();
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(3));
    expect(mocks.compare.mock.calls[2]![2]).toBe("sizeAndTimestamp");
    localStorage.removeItem("openidea.directoryCompare.mode");
  });

  it("compares other folders typed into the path fields or chosen with the folder chooser", async () => {
    const change = vi.fn();
    render(<DirectoryCompare left="/p/left" right="/p/right" onPathsChange={change} />);
    const leftField = screen.getByRole("textbox", { name: "Left folder" });
    expect(leftField).toHaveValue("/p/left");
    fireEvent.change(leftField, { target: { value: "/p/other" } });
    fireEvent.keyDown(leftField, { key: "Enter" });
    await waitFor(() => expect(change).toHaveBeenCalledWith("/p/other", "/p/right"));
    expect(mocks.kind).toHaveBeenCalledWith("/p/other");
    // A file, or the folder already on the other side, is refused with a message.
    mocks.kind.mockResolvedValueOnce(ok("file"));
    const rightField = screen.getByRole("textbox", { name: "Right folder" });
    fireEvent.change(rightField, { target: { value: "/p/file.txt" } });
    fireEvent.blur(rightField);
    expect(await screen.findByRole("alert")).toHaveTextContent("/p/file.txt is not a folder");
    fireEvent.change(rightField, { target: { value: "/p/left" } });
    fireEvent.keyDown(rightField, { key: "Enter" });
    expect(await screen.findByText("Choose two different folders")).toBeInTheDocument();
    fireEvent.keyDown(rightField, { key: "Escape" });
    expect(rightField).toHaveValue("/p/right");
    mocks.choose.mockResolvedValueOnce("/p/chosen");
    fireEvent.click(screen.getByRole("button", { name: "Choose right folder" }));
    await waitFor(() => expect(change).toHaveBeenCalledWith("/p/left", "/p/chosen"));
    expect(mocks.choose).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/p/right" }));
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("streams progress, cancels on demand and on close, and ignores stale results after refresh", async () => {
    let resolve!: (value: unknown) => void;
    mocks.compare.mockImplementationOnce((_l, _r, _mode, _request, channel) => {
      channel.onmessage({ scanned: 20, compared: 5, total: 10, bytesRead: 100, path: "big" });
      return new Promise((r) => {
        resolve = r;
      });
    });
    const view = setup();
    expect(await screen.findByText("Compared 5 of 10 entries")).toBeInTheDocument();
    const request = mocks.compare.mock.calls[0]![3];
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.cancel).toHaveBeenCalledWith(request);
    view.unmount();
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    resolve(ok(rows));
  });
});
