import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ navPythonStubs: vi.fn() }));
const nav = vi.hoisted(() => ({ openCodeLocation: vi.fn() }));
const fs = vi.hoisted(() => ({
  listeners: [] as ((e: { created: string[]; modified: string[]; removed: string[] }) => void)[],
}));

vi.mock("@/platform/ipc", () => ({
  isTauri: () => false,
  isCancelled: () => false,
  nextRequestId: () => 7,
  onIdeEvent: (_: string, listener: (typeof fs.listeners)[number]) => {
    fs.listeners.push(listener);
    return () => {};
  },
  call: async (p: Promise<{ status: string; data?: unknown; error?: unknown }>) => {
    const r = await p;
    if (r.status !== "ok") throw r.error;
    return r.data;
  },
  commands: ipc,
}));
vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/api")>()),
  whenSynced: () => Promise.resolve(),
  openCodeLocation: nav.openCodeLocation,
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { iconAreaExtension } from "@/editor/core/cm/iconArea";
import type { StubLink } from "@/platform/ipc";
import { linkAt, pythonStubGutter } from "./pythonStubs";

const range = (start: number, end = start) => ({ start: { line: start, col: 0 }, end: { line: end, col: 0 } });
const link = (name: string, start: number, end: number, target = 0): StubLink => ({
  name,
  range: range(start),
  extent: range(start, end),
  target: range(target),
});

describe("linkAt", () => {
  const links = [link("C", 4, 9), link("C.m", 6, 7), link("f", 11, 12)];

  it("picks the innermost declaration holding the line", () => {
    expect(linkAt(links, 7)?.name).toBe("C.m");
    expect(linkAt(links, 5)?.name).toBe("C");
    expect(linkAt(links, 12)?.name).toBe("f");
  });

  it("finds none outside every declaration", () => {
    expect(linkAt(links, 10)).toBeNull();
  });
});

describe("stub gutter", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    fs.listeners.length = 0;
    vi.clearAllMocks();
  });

  const answer = (counterpart: string, target: number) => ({
    status: "ok",
    data: {
      counterpart,
      links: [link("f", 0, 1, target)],
      candidates: ["/p/m.pyi", "/p/typings/m.pyi"],
    },
  });
  const changed = (path: string) => fs.listeners.forEach((l) => l({ created: [], modified: [path], removed: [] }));

  function open() {
    const ctx = { doc: 1, path: "/p/m.py", language: "python", virtual: false } as Parameters<
      typeof pythonStubGutter
    >[0];
    view = new EditorView({
      state: EditorState.create({
        doc: "def f():\n    pass\n",
        extensions: [pythonStubGutter(ctx), iconAreaExtension],
      }),
      parent: document.body,
    });
    return view;
  }

  async function clickOpens(path: string, line: number) {
    await vi.waitFor(
      () => {
        nav.openCodeLocation.mockClear();
        fireEvent.click(view!.dom.querySelector("[data-python-stub]")!);
        expect(nav.openCodeLocation).toHaveBeenCalledWith(path, { line, col: 0 });
      },
      { timeout: 2000 },
    );
  }

  it("opens the current target after the counterpart moves or changes", async () => {
    ipc.navPythonStubs.mockResolvedValue(answer("/p/m.pyi", 2));
    open();
    await clickOpens("/p/m.pyi", 2);

    // Lines inserted above the stub's declaration: the same title, a new target.
    ipc.navPythonStubs.mockResolvedValue(answer("/p/m.pyi", 5));
    changed("/p/m.pyi");
    await clickOpens("/p/m.pyi", 5);

    // The sibling stub deleted: the one in typings/ answers, with the same file name.
    ipc.navPythonStubs.mockResolvedValue(answer("/p/typings/m.pyi", 5));
    changed("/p/m.pyi");
    await clickOpens("/p/typings/m.pyi", 5);
  });

  it("refreshes only for changes where the counterpart may be", async () => {
    ipc.navPythonStubs.mockResolvedValue(answer("/p/m.pyi", 2));
    open();
    await vi.waitFor(() => expect(view!.dom.querySelector("[data-python-stub]")).not.toBeNull());
    expect(ipc.navPythonStubs).toHaveBeenCalledOnce();
    changed("/p/other.py");
    await new Promise((r) => setTimeout(r, 700));
    expect(ipc.navPythonStubs).toHaveBeenCalledOnce();
    changed("/p/typings/m.pyi");
    await vi.waitFor(() => expect(ipc.navPythonStubs).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });
});
