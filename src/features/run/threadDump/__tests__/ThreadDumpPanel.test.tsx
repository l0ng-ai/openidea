import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { addThreadDump, updateThreadDump, useStackTraces } from "../../stackTrace";
import { ThreadDumpPanel } from "../ThreadDumpPanel";
import { withDumpText, type ThreadDumpTab } from "../store";
import jdk25Sync from "../__fixtures__/jdk25-sync.txt?raw";
import jdk25None from "../__fixtures__/jdk25-none.txt?raw";

const clipboard = vi.hoisted(() => ({ writeClipboardText: vi.fn(async (_text: string) => {}) }));
vi.mock("@/platform/clipboard", async (orig) => ({ ...(await orig<object>()), ...clipboard }));

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
