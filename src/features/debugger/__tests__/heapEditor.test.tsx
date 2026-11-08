import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (p: unknown) => void = () => {};
  },
}));

const ipc = vi.hoisted(() => ({
  debugHeapDominators: vi.fn(),
  debugHeapPath: vi.fn(),
  debugHeapCompare: vi.fn(),
  debugHeapClose: vi.fn(),
  debugHeapSave: vi.fn(),
  cancelRequest: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type {
  HeapClassDiff,
  HeapClassRow,
  HeapObjectPage,
  HeapObjectRow,
  HeapPathStep,
  HeapSnapshotInfo,
  RemoteSession,
} from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { useRemote } from "@/platform/remote";
import {
  provideEditorService,
  provideNotificationService,
  type EditorInput,
  type EditorService,
} from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { forgetHeapOnProjectChange, useHeap } from "../heap/heapState";
import { heapInput } from "../heap/heapInput";
import { installHeapContext, openHeapDump } from "../heap/heapDumpFiles";
import { heapEditorKind } from "../heap/heapEditorKind";
import { HeapSnapshotEditor } from "../heap/HeapSnapshotEditor";

const captured = (id: number, label: string): HeapSnapshotInfo => ({
  id,
  label,
  origin: { kind: "captured", session: 1, pid: 4242, javaVersion: "21.0.2", takenWhileSuspended: true, dumpMs: 40 },
  summary: {
    objects: 12,
    reachableObjects: 10,
    reachableBytes: 1000,
    unreachableObjects: 2,
    unreachableBytes: 48,
    classes: 3,
    weakEdgesSkipped: 0,
    sizeSource: "jvm",
    analysisMs: 5,
  },
  createdMs: id,
});
const fromFile = (id: number): HeapSnapshotInfo => ({
  ...captured(id, "app.hprof"),
  origin: { kind: "file", path: "/tmp/app.hprof" },
  summary: { ...captured(id, "").summary, sizeSource: "addressGaps" },
});

const cls = (classIndex: number, name: string, count: number, shallow: number, retained: number): HeapClassRow => ({
  classIndex,
  name,
  count,
  shallow,
  retained,
  unreachableCount: 0,
  ambiguous: false,
});
const CLASSES = [cls(5, "Node", 3, 72, 104), cls(6, "java.lang.String", 1, 24, 48)];

const obj = (object: number, className = "Node", p: Partial<HeapObjectRow> = {}): HeapObjectRow => ({
  object,
  className,
  address: `0x${object.toString(16)}`,
  shallow: 24,
  retained: 40,
  hasChildren: false,
  preview: null,
  ...p,
});
const page = (rows: HeapObjectRow[], total = rows.length): HeapObjectPage => ({ rows, total });

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });

function keep(info: HeapSnapshotInfo, classes: HeapClassRow[] | null = CLASSES) {
  useHeap.setState((s) => ({ snapshots: { ...s.snapshots, [info.id]: { info, takenAtStop: null, classes } } }));
}

const SNAPSHOT = captured(7, "12:30:00");
const show = (info: HeapSnapshotInfo = SNAPSHOT) => render(<HeapSnapshotEditor input={heapInput(info)} />);
const classTable = () => screen.getByRole("table", { name: "Classes" });
const rowOf = (scope: HTMLElement, text: string) => within(scope).getByText(text).closest<HTMLElement>('[role="row"]')!;

beforeEach(() => {
  useHeap.setState({ snapshots: {}, captures: {}, opening: null });
  for (const m of Object.values(ipc)) m.mockReset();
  ipc.debugHeapDominators.mockReturnValue(ok(page([])));
  ipc.debugHeapPath.mockReturnValue(ok(null));
  ipc.debugHeapClose.mockReturnValue(ok(null));
  ipc.cancelRequest.mockResolvedValue(null);
});

afterEach(cleanup);

describe("HeapSnapshotEditor", () => {
  it("lists classes with retained sizes", () => {
    keep(SNAPSHOT);
    show();
    const row = rowOf(classTable(), "Node");
    expect(within(row).getByText("3")).toBeInTheDocument();
    expect(within(row).getByText("72 B")).toBeInTheDocument();
    expect(within(row).getByText("104 B")).toBeInTheDocument();
    // Sorted by retained size, biggest first.
    const names = within(classTable())
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector('[role="cell"]')?.textContent);
    expect(names).toEqual(["Node", "java.lang.String"]);
  });

  it("describes the snapshot in its header", () => {
    keep(SNAPSHOT);
    show();
    expect(screen.getByText("pid 4242 · JDK 21.0.2 · taken while suspended")).toBeInTheDocument();
    expect(screen.getByText("12 objects · 1000 B reachable · 48 B unreachable")).toBeInTheDocument();
    expect(screen.getByText("Sizes from the JVM.")).toBeInTheDocument();
  });

  it("filters and sorts the class table", () => {
    keep(SNAPSHOT);
    show();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter classes" }), { target: { value: "string" } });
    expect(within(classTable()).queryByText("Node")).toBeNull();
    expect(within(classTable()).getByText("java.lang.String")).toBeInTheDocument();
  });

  it("shows the biggest objects of the selected class", async () => {
    keep(SNAPSHOT);
    ipc.debugHeapDominators.mockReturnValue(ok(page([obj(16, "Node", { retained: 64 })])));
    show();
    fireEvent.mouseDown(rowOf(classTable(), "Node"));
    expect(await screen.findByText("Biggest objects of Node")).toBeInTheDocument();
    expect(ipc.debugHeapDominators).toHaveBeenCalledWith(7, null, 5, 0, 100);
    expect(await screen.findByText("Node@0x10")).toBeInTheDocument();
  });

  it("expands a dominator and shows more", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!;
    // Tall enough for the virtualised tree to render all 102 rows.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 4000 });
    try {
      keep(SNAPSHOT);
      const children = Array.from({ length: 100 }, (_, i) => obj(100 + i));
      ipc.debugHeapDominators.mockImplementation((_id, parent: number | null, _c, offset: number) => {
        if (parent === null) return ok(page([obj(1, "Cache", { hasChildren: true, retained: 500 })]));
        return ok(page(offset === 0 ? children : [obj(300)], 150));
      });
      show();
      fireEvent.click(screen.getByRole("tab", { name: "Dominators" }));
      const cache = await screen.findByText("Cache@0x1");
      expect(ipc.debugHeapDominators).toHaveBeenCalledWith(7, null, null, 0, 100);
      expect(within(cache.closest<HTMLElement>('[role="treeitem"]')!).getByText("50.0%")).toBeInTheDocument();
      fireEvent.mouseDown(cache.closest('[role="treeitem"]')!.querySelector("[data-tree-toggle]")!);
      await screen.findByText("Node@0x64");
      expect(ipc.debugHeapDominators).toHaveBeenCalledWith(7, 1, null, 0, 100);
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect(await screen.findByText("Node@0x12c")).toBeInTheDocument();
      expect(ipc.debugHeapDominators).toHaveBeenCalledWith(7, 1, null, 100, 100);
      expect(screen.queryByRole("button", { name: "Show more" })).not.toBeNull();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", original);
    }
  });

  it("keeps each view as it was when switching between them", async () => {
    keep(SNAPSHOT);
    ipc.debugHeapDominators.mockReturnValue(ok(page([obj(1, "Cache")])));
    show();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter classes" }), { target: { value: "string" } });
    fireEvent.click(screen.getByRole("tab", { name: "Dominators" }));
    await screen.findByText("Cache@0x1");
    fireEvent.click(screen.getByRole("tab", { name: "Classes" }));
    fireEvent.click(screen.getByRole("tab", { name: "Dominators" }));
    expect(ipc.debugHeapDominators).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Classes" }));
    expect(screen.getByRole("textbox", { name: "Filter classes" })).toHaveValue("string");
  });

  it("shows the path to the GC root of the selection", async () => {
    keep(SNAPSHOT);
    const steps: HeapPathStep[] = [
      { object: obj(16), via: { kind: "field", name: "next" } },
      { object: obj(17, "Node"), via: { kind: "root", root: "javaFrame", thread: "main" } },
    ];
    ipc.debugHeapDominators.mockReturnValue(ok(page([obj(16)])));
    ipc.debugHeapPath.mockReturnValue(ok({ steps, omitted: 0, omittedAfter: 0 }));
    show();
    fireEvent.mouseDown(rowOf(classTable(), "Node"));
    fireEvent.mouseDown(rowOf(await screen.findByRole("table", { name: "Biggest objects of Node" }), "Node@0x10"));
    const path = await screen.findByRole("region", { name: "Path to GC Root" });
    expect(await within(path).findByText(".next")).toBeInTheDocument();
    expect(within(path).getByText("Local variable in main")).toBeInTheDocument();
    expect(within(path).queryByText(/Path truncated/)).not.toBeInTheDocument();
    expect(ipc.debugHeapPath).toHaveBeenCalledWith(7, 16);
  });

  it("says where a long path to the GC root leaves steps out", async () => {
    keep(SNAPSHOT);
    const steps: HeapPathStep[] = [
      { object: obj(16), via: { kind: "field", name: "next" } },
      { object: obj(17, "Node"), via: { kind: "field", name: "prev" } },
      { object: obj(18, "Node"), via: { kind: "root", root: "javaFrame", thread: "main" } },
    ];
    ipc.debugHeapDominators.mockReturnValue(ok(page([obj(16)])));
    ipc.debugHeapPath.mockReturnValue(ok({ steps, omitted: 2000, omittedAfter: 1 }));
    show();
    fireEvent.mouseDown(rowOf(classTable(), "Node"));
    fireEvent.mouseDown(rowOf(await screen.findByRole("table", { name: "Biggest objects of Node" }), "Node@0x10"));
    const path = await screen.findByRole("region", { name: "Path to GC Root" });
    const gap = await within(path).findByText(`Path truncated: ${(2000).toLocaleString()} steps not shown`);
    const rows = within(path).getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining(".next"),
      gap.textContent,
      expect.stringContaining(".prev"),
      expect.stringContaining("Local variable in main"),
    ]);
  });

  it("says when the selection is not reachable from a GC root", async () => {
    keep(SNAPSHOT);
    ipc.debugHeapDominators.mockReturnValue(ok(page([obj(16)])));
    show();
    fireEvent.mouseDown(rowOf(classTable(), "Node"));
    fireEvent.mouseDown(rowOf(await screen.findByRole("table", { name: "Biggest objects of Node" }), "Node@0x10"));
    expect(await screen.findByText("This object is not reachable from a GC root.")).toBeInTheDocument();
  });

  it("quotes string previews but not the class a class object stands for", async () => {
    keep(SNAPSHOT);
    ipc.debugHeapDominators.mockReturnValue(
      ok(
        page([
          obj(16, "java.lang.String", { preview: "hello" }),
          obj(17, "java.lang.Class", { preview: "com.example.Node" }),
        ]),
      ),
    );
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Dominators" }));
    expect(await screen.findByText('"hello"')).toBeInTheDocument();
    expect(screen.getByText("com.example.Node")).toBeInTheDocument();
  });

  it("compares with another open snapshot", async () => {
    keep(SNAPSHOT);
    keep(captured(8, "12:31:00"));
    const diff: HeapClassDiff = {
      name: "Node",
      baseCount: 1,
      count: 3,
      baseShallow: 24,
      shallow: 72,
      baseRetained: 40,
      retained: 104,
      ambiguous: false,
    };
    ipc.debugHeapCompare.mockReturnValue(ok([diff, { ...diff, name: "java.lang.String", ambiguous: true }]));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Compare with…" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "12:31:00" }));
    await waitFor(() => expect(within(classTable()).getByRole("columnheader", { name: "Count Diff" })).toBeVisible());
    expect(ipc.debugHeapCompare).toHaveBeenCalledWith(8, 7);
    const row = rowOf(classTable(), "Node");
    expect(within(row).getByText("+2")).toBeInTheDocument();
    expect(within(row).getByText("+64 B")).toBeInTheDocument();
    // A name shared by several classes has no difference to show.
    expect(within(rowOf(classTable(), "java.lang.String")).getAllByText("—")).toHaveLength(2);
  });

  it("offers no snapshot of the previous project to compare with", () => {
    useProject.setState({ project: { root: "/a" } as never });
    const stop = forgetHeapOnProjectChange();
    try {
      keep(SNAPSHOT);
      keep(captured(8, "12:31:00"));
      act(() => useProject.setState({ project: { root: "/b" } as never }));
      const next = captured(9, "12:40:00");
      keep(next);
      show(next);
      expect(screen.getByRole("button", { name: "Compare with…" })).toBeDisabled();
      expect(Object.keys(useHeap.getState().snapshots)).toEqual(["9"]);
    } finally {
      stop();
      useProject.setState({ project: null });
    }
  });

  it("offers Save for captured snapshots only", () => {
    keep(SNAPSHOT);
    show();
    expect(screen.getByRole("button", { name: "Save Heap Dump As…" })).toBeInTheDocument();
  });

  it("hides Save for files opened from disk", () => {
    const file = fromFile(9);
    keep(file);
    show(file);
    expect(screen.getByText("/tmp/app.hprof")).toBeInTheDocument();
    expect(screen.getByText("Sizes estimated from the dump.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Heap Dump As…" })).toBeNull();
  });

  it("says so when the snapshot belongs to another window", () => {
    show();
    expect(screen.getByText("This heap snapshot is not available in this window.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers Save As for the active captured snapshot of a local window only", () => {
    keep(SNAPSHOT);
    keep(fromFile(9));
    let active: EditorInput | null = heapInput(SNAPSHOT);
    let changed: (input: EditorInput | null) => void = () => {};
    provideEditorService({
      activeInput: () => active,
      onActiveInputChange: (fn: (input: EditorInput | null) => void) => {
        changed = fn;
        return () => {};
      },
    } as unknown as EditorService);
    const uninstall = installHeapContext();
    try {
      expect(getContext().debugHeapSnapshotCaptured).toBe(true);
      active = heapInput(fromFile(9));
      changed(active);
      expect(getContext().debugHeapSnapshotCaptured).toBe(false);
      active = heapInput(SNAPSHOT);
      act(() => useRemote.setState({ session: {} as RemoteSession }));
      expect(getContext().debugHeapSnapshotCaptured).toBe(false);
    } finally {
      useRemote.setState({ session: null });
      uninstall();
    }
  });

  it("opens heap dumps in local windows only", async () => {
    const notify = vi.fn();
    provideNotificationService({ notify });
    useRemote.setState({ session: {} as RemoteSession });
    try {
      await openHeapDump();
    } finally {
      useRemote.setState({ session: null });
    }
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Heap dumps can be opened in local windows only." }),
    );
  });

  it("closing the tab closes the snapshot", async () => {
    keep(SNAPSHOT);
    expect(heapEditorKind.title(heapInput(SNAPSHOT))).toBe("Heap: 12:30:00");
    await act(async () => heapEditorKind.onClose!(heapInput(SNAPSHOT)));
    expect(ipc.debugHeapClose).toHaveBeenCalledWith(7);
    expect(ipc.debugHeapClose).toHaveBeenCalledTimes(1);
    expect(useHeap.getState().snapshots[7]).toBeUndefined();
    expect(heapEditorKind.restorable).toBeFalsy();
  });
});
