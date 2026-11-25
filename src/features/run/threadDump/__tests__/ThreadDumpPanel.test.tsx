import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { commands, type VirtualThreadsNote } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { addThreadDump, updateThreadDump, useStackTraces } from "../../stackTrace";
import { ThreadDumpPanel } from "../ThreadDumpPanel";
import { withDumpText, type ThreadDumpTab, type VirtualSource } from "../store";
import jdk25Sync from "../__fixtures__/jdk25-sync.txt?raw";
import jdk25None from "../__fixtures__/jdk25-none.txt?raw";
import jdk21Mixed from "../__fixtures__/jdk21-mixed.txt?raw";
import jdk21Vjuc from "../__fixtures__/jdk21-vjuc.json?raw";
import jdk25Vjuc from "../__fixtures__/jdk25-vjuc.json?raw";
import jdk25Vsync from "../__fixtures__/jdk25-vsync.json?raw";

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

function openTaken(text: string, virtual: VirtualSource) {
  const id = addThreadDump(text, { title: "Threads: App", source: { run: 7, token: "cfg" }, virtual });
  render(<Harness id={id} />);
  return id;
}

const json25 = (virtualJson: string): VirtualSource => ({ javaVersion: "25.0.3", virtualJson, virtualNote: null });

function virtualDump(containers: [container: string, names: string[]][]): string {
  return JSON.stringify({
    threadDump: {
      runtimeVersion: "25.0.3",
      threadContainers: containers.map(([container, names]) => ({
        container,
        threads: names.map((name, i) => ({ tid: String(100 + i), name, virtual: true, state: "WAITING", stack: [] })),
      })),
    },
  });
}

const vthread = (tid: string, state: string, extra: object = {}) => ({
  tid,
  name: "",
  virtual: true,
  state,
  stack: ["Work.run(Work.java:5)", "java.base/java.lang.VirtualThread.run(VirtualThread.java:460)"],
  ...extra,
});

/** Unnamed virtual threads, as `Thread.ofVirtual()` makes them: #101 and #102 deadlock, #103 sits in an unnamed container. */
const unnamedDump = JSON.stringify({
  threadDump: {
    runtimeVersion: "25.0.3",
    threadContainers: [
      {
        container: "java.util.concurrent.ThreadPerTaskExecutor@2a",
        threads: [
          vthread("101", "BLOCKED", {
            blockedOn: "java.lang.Object@b",
            monitorsOwned: [{ depth: 1, locks: ["java.lang.Object@a"] }],
          }),
          vthread("102", "BLOCKED", {
            blockedOn: "java.lang.Object@a",
            monitorsOwned: [{ depth: 1, locks: ["java.lang.Object@b"] }],
          }),
        ],
      },
      { container: "", threads: [vthread("103", "WAITING")] },
    ],
  },
});

/** Thread names and section headings, top to bottom. */
const listLines = () =>
  [...screen.getByRole("listbox", { name: "Threads" }).querySelectorAll('[role="option"], [role="presentation"]')].map(
    (el) => el.textContent,
  );

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

describe("virtual threads", () => {
  it("lists them after the platform threads, grouped by container", () => {
    openTaken(
      jdk25None,
      json25(
        virtualDump([
          ["<root>", ["v-a"]],
          ["java.util.concurrent.ThreadPerTaskExecutor@1f", ["v-b", "v-c"]],
        ]),
      ),
    );
    const lines = listLines();
    const group = lines.indexOf("Virtual threads (3)");
    expect(group).toBeGreaterThan(lines.indexOf("main"));
    expect(lines.slice(group)).toEqual([
      "Virtual threads (3)",
      "<root>",
      "v-a",
      "java.util.concurrent.ThreadPerTaskExecutor@1f",
      "v-b",
      "v-c",
    ]);
  });

  it("counts only the virtual threads the filter leaves", () => {
    openTaken(jdk25None, json25(virtualDump([["<root>", ["v-a", "w-b"]]])));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter threads" }), { target: { value: "v-" } });
    expect(listLines()).toEqual(["Virtual threads (1)", "<root>", "v-a"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter threads" }), { target: { value: "main" } });
    expect(listLines()).toEqual(["main"]);
  });

  it("shows a selected virtual thread's stack", () => {
    openTaken(jdk25None, json25(jdk25Vsync));
    fireEvent.mouseDown(rows().find((r) => r.textContent === "v-sync-2")!);
    expect(selectedName()).toBe("v-sync-2");
    expect(screen.getByRole("log").textContent).toContain('"v-sync-2"');
  });

  it("names a virtual-thread deadlock in the banner and marks its threads", () => {
    openTaken(jdk25None, json25(jdk25Vsync));
    expect(screen.getByRole("alert").textContent).toContain("v-sync-1 → v-sync-2 → v-sync-1");
    const marked = rows().filter((r) => within(r).queryByLabelText("Deadlocked"));
    expect(marked.map((r) => r.textContent)).toEqual(["v-sync-1", "v-sync-2"]);
    expect(selectedName()).toBe("v-sync-1");
  });

  it("names platform and virtual deadlocks together", () => {
    openTaken(jdk25Sync, json25(jdk25Vsync));
    const banner = screen.getByRole("alert").textContent;
    expect(banner).toContain("sync-1 → sync-2 → sync-1");
    expect(banner).toContain("v-sync-1 → v-sync-2 → v-sync-1");
  });

  it("says that Java 21 to 24 name no lock owners", () => {
    openTaken(jdk21Mixed, { javaVersion: "21.0.4", virtualJson: jdk21Vjuc, virtualNote: null });
    expect(listLines()).toContain("Virtual threads (2)");
    expect(screen.getByRole("note").textContent).toBe("Lock owners of virtual threads need Java 25 or later.");
  });

  it("counts no state for JDK 21 virtual threads, which have none", () => {
    openTaken(jdk21Mixed, { javaVersion: "21.0.4", virtualJson: jdk21Vjuc, virtualNote: null });
    expect(screen.getByTestId("thread-state-counts").textContent).not.toContain("UNKNOWN");
    const row = rows().find((r) => r.textContent === "v-juc-1")!;
    expect(within(row).getByLabelText("State unknown")).toBeTruthy();
  });

  it("adds no note to a Java 25 dump", () => {
    openTaken(jdk25None, json25(jdk25Vjuc));
    expect(listLines()).toContain("Virtual threads (2)");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it.each<[VirtualThreadsNote, string]>([
    ["whileSuspended", "Virtual threads are not listed while the debugger stops the program."],
    ["tooLarge", "Virtual threads are not listed: there are too many to read."],
    ["failed", "Virtual threads are not listed: the JVM could not report them."],
  ])("explains why a %s dump lists none", (virtualNote, text) => {
    openTaken(jdk25None, { javaVersion: "25", virtualJson: null, virtualNote });
    expect(screen.getByRole("note").textContent).toBe(text);
    expect(listLines()).not.toContain("Virtual threads (0)");
  });

  it("shows neither a group nor a note below Java 21 or when the version is unknown", () => {
    openTaken(jdk25None, { javaVersion: "17.0.12", virtualJson: null, virtualNote: null });
    openTaken(jdk25None, { javaVersion: "", virtualJson: null, virtualNote: null });
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/^Virtual threads/)).toBeNull();
  });
});

describe("unnamed virtual threads", () => {
  it("go by their thread id in the list, under a named heading", () => {
    openTaken(jdk25None, json25(unnamedDump));
    const lines = listLines();
    expect(lines.slice(lines.indexOf("Virtual threads (3)"))).toEqual([
      "Virtual threads (3)",
      "java.util.concurrent.ThreadPerTaskExecutor@2a",
      "#101",
      "#102",
      "Unnamed container",
      "#103",
    ]);
  });

  it("are found by the filter", () => {
    openTaken(jdk25None, json25(unnamedDump));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter threads" }), { target: { value: "#102" } });
    expect(listLines()).toEqual(["Virtual threads (1)", "java.util.concurrent.ThreadPerTaskExecutor@2a", "#102"]);
  });

  it("are selected from the deadlock banner, and their stack is headed by the id", () => {
    openTaken(jdk25None, json25(unnamedDump));
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("#101 → #102 → #101");
    expect(
      rows()
        .filter((r) => within(r).queryByLabelText("Deadlocked"))
        .map((r) => r.textContent),
    ).toEqual(["#101", "#102"]);
    fireEvent.click(within(banner).getAllByRole("button", { name: "#102" })[0]!);
    expect(selectedName()).toBe("#102");
    const stack = screen.getByRole("log", { name: "Stack of #102" }).textContent;
    expect(stack).toContain("#102 daemon");
    expect(stack).not.toContain('""');
  });

  it("keep the selected one across Refresh", () => {
    const id = openTaken(jdk25None, json25(unnamedDump));
    fireEvent.click(within(screen.getByRole("alert")).getAllByRole("button", { name: "#102" })[0]!);
    act(() => updateThreadDump(id, (t) => withDumpText(t, jdk25None, json25(unnamedDump))));
    expect(selectedName()).toBe("#102");
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
    const after = withDumpText({ ...before, selected: main }, jdk25None, null);
    expect(after.text).toBe(jdk25None);
    expect(after.filter).toBe("s");
    expect(after.hideJvm).toBe(false);
    expect(after.dump.threads[after.selected!]!.name).toBe("main");
    expect(after.dump.deadlocks).toEqual([]);
  });

  it("replaces the virtual threads and their note with the new dump's", () => {
    const id = addThreadDump(jdk25None, {
      title: "Threads: App",
      source: { session: 3 },
      virtual: json25(jdk25Vsync),
    });
    const before = threadsTab(id);
    expect(before.dump.deadlocks).toHaveLength(1);
    const after = withDumpText(before, jdk25None, { javaVersion: "21.0.4", virtualJson: jdk21Vjuc, virtualNote: null });
    expect(after.dump.threads.filter((t) => t.container !== undefined).map((t) => t.name)).toEqual([
      "v-juc-1",
      "v-juc-2",
    ]);
    expect(after.dump.deadlocks).toEqual([]);
    expect(after.virtualNote).toBe("noLockOwners");
  });
});
