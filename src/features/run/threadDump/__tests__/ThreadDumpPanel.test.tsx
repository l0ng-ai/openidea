import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { commands } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { addThreadDump, updateThreadDump, useStackTraces } from "../../stackTrace";
import { ThreadDumpPanel } from "../ThreadDumpPanel";
import { withDumpText, type ThreadDumpTab } from "../store";
import jdk25Sync from "../__fixtures__/jdk25-sync.txt?raw";
import jdk25None from "../__fixtures__/jdk25-none.txt?raw";

const clipboard = vi.hoisted(() => ({ writeClipboardText: vi.fn(async (_text: string) => {}) }));
vi.mock("@/platform/clipboard", async (orig) => ({ ...(await orig<object>()), ...clipboard }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));
const dialog = vi.hoisted(() => ({ save: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("@/platform/dialog", () => dialog);
const remote = vi.hoisted(() => ({ isRemoteWindow: vi.fn(() => false) }));
vi.mock("@/platform/remote", async (orig) => ({ ...(await orig<object>()), ...remote }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 20, key: index, size: 20 })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

function threadsTab(id: string): ThreadDumpTab {
  const tab = useStackTraces.getState().tabs.find((t) => t.id === id);
  if (tab?.kind !== "threads") throw new Error("expected a thread dump tab");
  return tab;
}

function Harness({ id }: { id: string }) {
  const tab = useStackTraces((s) => s.tabs.find((t) => t.id === id));
  return tab?.kind === "threads" ? <ThreadDumpPanel tab={tab} /> : null;
}

function open(text: string, source: ThreadDumpTab["source"] = null) {
  const id = addThreadDump(text, { title: "Threads: App", source });
  render(<Harness id={id} />);
  return id;
}

const rows = () => within(screen.getByRole("listbox", { name: "Threads" })).getAllByRole("option");
const rowNames = () => rows().map((r) => r.textContent);
const selectedName = () => rows().find((r) => r.getAttribute("aria-selected") === "true")?.textContent;

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  useStackTraces.setState({ tabs: [] });
  clipboard.writeClipboardText.mockClear();
  notify.mockClear();
  remote.isRemoteWindow.mockReturnValue(false);
});

describe("ThreadDumpPanel", () => {
  it("names the deadlock cycle and selects a thread from it", () => {
    open(jdk25Sync);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("sync-1 → sync-2 → sync-1");
    expect(selectedName()).toBe("sync-1");
    fireEvent.click(within(banner).getAllByRole("button", { name: "sync-2" })[0]!);
    expect(selectedName()).toBe("sync-2");
    expect(screen.getByRole("log").textContent).toContain("Deadlock.java:11");
  });

  it("marks deadlocked threads in the list", () => {
    open(jdk25Sync);
    const marked = rows().filter((r) => within(r).queryByLabelText("Deadlocked"));
    expect(marked.map((r) => r.textContent)).toEqual(["sync-1", "sync-2"]);
  });

  it("filters the list by thread name", () => {
    open(jdk25Sync);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter threads" }), { target: { value: "SYNC" } });
    expect(rowNames()).toEqual(["sync-1", "sync-2"]);
  });

  it("hides JVM threads until the toggle shows them", () => {
    open(jdk25Sync);
    expect(rowNames()).toEqual(["main", "sync-1", "sync-2"]);
    const toggle = screen.getByRole("button", { name: "Hide JVM threads" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(rowNames()).toContain("Reference Handler");
    expect(rowNames()).toContain("VM Thread");
  });

  it("counts the listed threads per state", () => {
    open(jdk25Sync);
    const counts = screen.getByTestId("thread-state-counts").textContent;
    expect(counts).toContain("BLOCKED 2");
    expect(counts).toContain("TIMED_WAITING 1");
  });

  it("selects main when no thread is deadlocked, and shows no banner", () => {
    open(jdk25None);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(selectedName()).toBe("main");
  });

  it("copies the whole dump", () => {
    open(jdk25Sync);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    const copied = clipboard.writeClipboardText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("Full thread dump");
    expect(copied).toContain("Found one Java-level deadlock:");
  });

  it("offers Refresh only for a dump taken from a run or debug session", () => {
    open(jdk25Sync);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("refreshes through the tab's refresh function", () => {
    const id = open(jdk25Sync, { run: 7, token: "cfg" });
    const refresh = vi.fn(async () => {});
    act(() => updateThreadDump(id, (t) => ({ ...t, refresh })));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reports a refresh that fails", async () => {
    const id = open(jdk25Sync, { session: 3 });
    act(() => updateThreadDump(id, (t) => ({ ...t, refresh: async () => Promise.reject(new Error("gone")) })));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cannot take a new thread dump", body: "gone" }),
      ),
    );
  });
});

describe("Save As…", () => {
  const ok = { status: "ok", data: null } as const;
  let onDisk: Record<string, "file" | "dir">;
  let written: { path: string; text: string }[];

  beforeEach(() => {
    onDisk = {};
    written = [];
    dialog.save.mockResolvedValue("/out/dump.txt");
    vi.spyOn(commands, "fsEntryKind").mockImplementation(async (path) =>
      onDisk[path]
        ? { status: "ok", data: onDisk[path] }
        : { status: "error", error: { kind: "NotFound", message: path } as never },
    );
    vi.spyOn(commands, "fsDelete").mockImplementation(async (path) => {
      delete onDisk[path];
      return ok;
    });
    vi.spyOn(commands, "fsCreateFileBytes").mockImplementation(async (path, data) => {
      if (onDisk[path]) return { status: "error", error: { kind: "AlreadyExists", message: path } as never };
      written.push({ path, text: new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))) });
      return ok;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const save = () => fireEvent.click(screen.getByRole("button", { name: "Save As…" }));

  it("writes the whole dump to a .txt file named after the tab", async () => {
    const id = open(jdk25Sync);
    save();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(dialog.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "Threads- App.txt" }));
    expect(written[0]).toEqual({ path: "/out/dump.txt", text: threadsTab(id).text });
    expect(commands.fsDelete).not.toHaveBeenCalled();
  });

  it("replaces an existing file", async () => {
    onDisk["/out/dump.txt"] = "file";
    open(jdk25Sync);
    save();
    await waitFor(() => expect(written).toHaveLength(1));
    expect(commands.fsDelete).toHaveBeenCalledWith("/out/dump.txt");
  });

  it("refuses to replace a directory", async () => {
    onDisk["/out/dump.txt"] = "dir";
    open(jdk25Sync);
    save();
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cannot save the thread dump", body: "/out/dump.txt is a directory" }),
      ),
    );
    expect(commands.fsDelete).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("reports a failed write", async () => {
    vi.mocked(commands.fsCreateFileBytes).mockResolvedValue({
      status: "error",
      error: { kind: "PermissionDenied", message: "read-only volume" } as never,
    });
    open(jdk25Sync);
    save();
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Cannot save the thread dump" })),
    );
  });

  it("is not offered in a remote window", () => {
    remote.isRemoteWindow.mockReturnValue(true);
    open(jdk25Sync);
    expect(screen.queryByRole("button", { name: "Save As…" })).toBeNull();
  });
});

describe("withDumpText", () => {
  it("keeps the selected thread, filter and toggle across a new dump", () => {
    const id = addThreadDump(jdk25Sync, { title: "Threads: App", source: null });
    const before = { ...threadsTab(id), filter: "s", hideJvm: false };
    const main = before.dump.threads.findIndex((t) => t.name === "main");
    const after = withDumpText({ ...before, selected: main }, jdk25None);
    expect(after.text).toBe(jdk25None);
    expect(after.filter).toBe("s");
    expect(after.hideJvm).toBe(false);
    expect(after.dump.threads[after.selected!]!.name).toBe("main");
    expect(after.dump.deadlocks).toEqual([]);
  });
});
