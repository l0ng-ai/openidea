import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../DiffEditor", () => ({
  ResolvedDiffEditor: ({ input, fit }: { input: { data: { path: string; mode?: string } }; fit?: boolean }) => (
    <div data-testid="block-diff" data-path={input.data.path} data-mode={input.data.mode} data-fit={String(!!fit)} />
  ),
}));

import { provideEditorService, type EditorInput } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { allInOneDiff, combinedOf, setAllInOneDiff } from "../allInOneDiff";
import { CombinedDiffTab, blockKind } from "../CombinedDiff";
import { COMBINED_DIFF_KIND } from "../allInOneDiff";
import { combinedDiffInput, openDiff, withChain, type DiffData } from "../diffInput";

const diff = (path: string, extra: Partial<DiffData> = {}): DiffData => ({
  path,
  left: { type: "rev", rev: "HEAD" },
  right: { type: "worktree" },
  ...extra,
});
const items = [diff("/r/src/a.ts"), diff("/r/src/b.ts"), diff("/r/c.md")];

const openInput = vi.fn(async (_input: EditorInput, _opts?: unknown) => undefined);
const closeInput = vi.fn();
const openFile = vi.fn(async () => undefined);
provideEditorService({ openInput, openFile, closeInput } as never);

beforeEach(() => {
  localStorage.clear();
  useProject.setState({ project: { name: "r", root: "/r", trusted: true, isGit: true, settings: {} } as never });
  openInput.mockClear();
  closeInput.mockClear();
});

describe("all-in-one diff", () => {
  it("is off by default; on, a diff of a change with several files opens all of them", () => {
    expect(allInOneDiff()).toBe(false);
    expect(combinedOf(withChain(items, 1))).toBeNull();
    setAllInOneDiff(true);
    expect(combinedOf(withChain(items, 1))).toMatchObject({ reveal: "/r/src/b.ts" });
    expect(combinedOf(withChain(items, 1))!.items).toHaveLength(3);
    // One file, or a diff shown inside another view, stays as it is.
    expect(combinedOf(diff("/r/a"))).toBeNull();
    expect(combinedOf({ ...withChain(items, 0), embedded: true })).toBeNull();
  });

  it("opens one tab per change, whichever of its files asked", async () => {
    setAllInOneDiff(true);
    await openDiff(withChain(items, 0));
    await openDiff({ ...withChain(items, 2), line: 4 });
    const [first, second] = openInput.mock.calls.map((c) => c[0]);
    expect(first!.kind).toBe(COMBINED_DIFF_KIND);
    expect(second!.key).toBe(first!.key);
    expect(second!.path).toBe("/r/c.md");
    // The blocks don't carry the chain or the reveal of the file that opened them.
    const blocks = (first!.data as { items: DiffData[] }).items;
    expect(blocks.every((b) => !b.chain && b.line === undefined)).toBe(true);
  });

  it("keeps one diff per file while off", async () => {
    await openDiff(withChain(items, 0));
    expect(openInput.mock.calls[0]![0].kind).toBe("diff");
  });

  it("tells added and deleted files from the absent side", () => {
    expect(blockKind(diff("/r/a", { left: { type: "text", text: "", label: "", absent: true } }))).toBe("added");
    expect(blockKind(diff("/r/a", { right: { type: "text", text: "", label: "", absent: true } }))).toBe("deleted");
    expect(blockKind(diff("/r/a"))).toBe("modified");
  });
});

describe("the all-in-one diff tab", () => {
  const input = combinedDiffInput({ items });

  it("shows a block per file, each diff fitted to its content", () => {
    render(<CombinedDiffTab input={input} />);
    expect(screen.getByText("3 files")).toBeTruthy();
    const blocks = screen.getAllByTestId("block-diff");
    expect(blocks.map((b) => b.dataset.path)).toEqual(["/r/src/a.ts", "/r/src/b.ts", "/r/c.md"]);
    expect(blocks.every((b) => b.dataset.fit === "true")).toBe(true);
    expect(screen.getAllByText("src")).toHaveLength(2);
  });

  it("collapses a file and all files, keeping their diffs (and unsaved edits) loaded", () => {
    render(<CombinedDiffTab input={input} />);
    const shown = () => screen.queryAllByTestId("block-diff").filter((b) => !b.closest("[hidden]"));
    const first = screen.getAllByTestId("block-diff")[0]!;
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Collapse File" })[0]!);
    });
    expect(shown()).toHaveLength(2);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
    });
    expect(shown()).toHaveLength(0);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Expand All Files" }));
    });
    expect(shown()).toHaveLength(3);
    // The same diff all along: collapsing never released its document.
    expect(screen.getAllByTestId("block-diff")[0]).toBe(first);
  });

  it("switches every block between side-by-side and unified, collapsed ones too, in place", () => {
    render(<CombinedDiffTab input={input} />);
    const before = screen.getAllByTestId("block-diff");
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Collapse File" })[0]!);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Unified Viewer" }));
    });
    const after = screen.getAllByTestId("block-diff");
    expect(after.every((b) => b.dataset.mode === "unified")).toBe(true);
    // The same diffs: switching never released their documents (and unsaved edits).
    expect(after).toEqual(before);
    after.forEach((b, i) => expect(b).toBe(before[i]));
  });

  it("opens a file's own diff, and goes back to one tab per file", async () => {
    setAllInOneDiff(true);
    render(<CombinedDiffTab input={input} />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Open in Separate Tab" })[1]!);
    });
    const own = openInput.mock.calls[0]![0];
    expect(own).toMatchObject({ kind: "diff", path: "/r/src/b.ts" });
    expect((own.data as DiffData).chain).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show Files in Separate Diff Tabs" }));
    });
    expect(allInOneDiff()).toBe(false);
    expect(openInput.mock.calls[1]![0].kind).toBe("diff");
    expect(closeInput).toHaveBeenCalledWith(input.key);
  });
});

describe("the all-in-one diff tab with many files", () => {
  // jsdom has no layout: every element is 600 px tall (test setup), the scroller too, so one
  // block fills the view. Scrolling is a `scrollTop` the virtualizer reads on `scroll`.
  const offsets = new WeakMap<Element, number>();
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return offsets.get(this) ?? 0;
      },
      set(value: number) {
        offsets.set(this, value);
      },
    });
    // As tall as its content: the virtualizer clamps where it scrolls to the scroll height.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return (
          Number.parseFloat((this as HTMLElement).querySelector<HTMLElement>("[style*=height]")?.style.height ?? "") ||
          0
        );
      },
    });
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
      this.scrollTop = typeof options === "number" ? options : (options?.top ?? 0);
      this.dispatchEvent(new Event("scroll"));
    };
    HTMLElement.prototype.scrollBy = function (this: HTMLElement, options?: ScrollToOptions | number) {
      this.scrollTop += typeof options === "number" ? options : (options?.top ?? 0);
      this.dispatchEvent(new Event("scroll"));
    };
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => diff(`/r/src/File${i}.ts`));
  const scrollBy = (dy: number) => {
    const el = document.querySelector<HTMLElement>("[data-combined-scroll]")!;
    act(() => {
      el.scrollTop += dy;
      el.dispatchEvent(new Event("scroll"));
    });
  };
  const mounted = () => screen.queryAllByTestId("block-diff").map((b) => b.dataset.path!);

  it("mounts only the blocks near the view while scrolling, and reaches every file", () => {
    const files = many(60);
    render(<CombinedDiffTab input={combinedDiffInput({ items: files })} />);
    const seen = new Set(mounted());
    let peak = seen.size;
    for (let i = 0; i < files.length; i++) {
      scrollBy(600);
      mounted().forEach((p) => seen.add(p));
      peak = Math.max(peak, mounted().length);
    }
    // A screenful and four blocks on each side, however many files there are.
    expect(peak).toBeLessThanOrEqual(12);
    expect(seen).toEqual(new Set(files.map((f) => f.path)));
    expect(mounted()).toContain("/r/src/File59.ts");
    expect(mounted()).not.toContain("/r/src/File0.ts");
  });

  /** The block at the top of the view: its slot starts where the view does. */
  const atTop = () => {
    const el = document.querySelector<HTMLElement>("[data-combined-scroll]")!;
    const slot = [...el.querySelectorAll<HTMLElement>("[data-index]")].find(
      (s) => Number.parseFloat(s.style.top) === el.scrollTop,
    );
    return slot?.querySelector<HTMLElement>("[data-combined-block]")?.dataset.combinedBlock;
  };

  it("opens at the file asked for, before any block below the first was measured", async () => {
    const files = many(60);
    render(<CombinedDiffTab input={combinedDiffInput({ items: files, reveal: "/r/src/File40.ts" })} />);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(atTop()).toBe("/r/src/File40.ts");
  });

  it("steps to the next and previous file", async () => {
    render(<CombinedDiffTab input={combinedDiffInput({ items: many(60) })} />);
    const click = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name }));
      await act(() => new Promise((r) => setTimeout(r, 50)));
    };
    await click("Next File");
    expect(atTop()).toBe("/r/src/File1.ts");
    await click("Next File");
    await click("Next File");
    expect(atTop()).toBe("/r/src/File3.ts");
    await click("Previous File");
    expect(atTop()).toBe("/r/src/File2.ts");
  });

  describe("as blocks above the view grow once their diffs load", () => {
    // Slots report their size through the virtualizer's ResizeObserver, the way a loaded diff does.
    const observers = new Map<ResizeObserverCallback, Set<Element>>();
    const original = window.ResizeObserver;
    beforeEach(() => {
      window.ResizeObserver = class {
        targets = new Set<Element>();
        constructor(callback: ResizeObserverCallback) {
          observers.set(callback, this.targets);
        }
        observe(target: Element) {
          this.targets.add(target);
        }
        unobserve(target: Element) {
          this.targets.delete(target);
        }
        disconnect() {
          this.targets.clear();
        }
      } as never;
    });
    afterEach(() => {
      window.ResizeObserver = original;
      observers.clear();
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
    });
    const grow = (index: number, height: number) => {
      const slot = document.querySelector(`[data-index="${index}"]`)!;
      const [callback] = [...observers].find(([, targets]) => targets.has(slot))!;
      act(() =>
        callback([{ target: slot, borderBoxSize: [{ blockSize: height, inlineSize: 400 }] }] as never, {} as never),
      );
    };
    /** How far below the top of the view a file's block starts. */
    const below = (path: string) => {
      const el = document.querySelector<HTMLElement>("[data-combined-scroll]")!;
      const block = el.querySelector(`[data-combined-block="${path}"]`)!;
      return Number.parseFloat(block.closest<HTMLElement>("[data-index]")!.style.top) - el.scrollTop;
    };

    it("stays on the file it opened at", async () => {
      // Still loading, the blocks are shorter than the estimate.
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 40 });
      render(<CombinedDiffTab input={combinedDiffInput({ items: many(60), reveal: "/r/src/File40.ts" })} />);
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(atTop()).toBe("/r/src/File40.ts");
      grow(38, 3000);
      grow(39, 5000);
      expect(atTop()).toBe("/r/src/File40.ts");
    });

    it("keeps what is shown in place while scrolling up", async () => {
      render(<CombinedDiffTab input={combinedDiffInput({ items: many(60), reveal: "/r/src/File40.ts" })} />);
      await act(() => new Promise((r) => setTimeout(r, 50)));
      scrollBy(-300);
      expect(below("/r/src/File40.ts")).toBe(300);
      grow(38, 130_000);
      expect(below("/r/src/File40.ts")).toBe(300);
    });

    it("keeps the wheel scrolling the view has not reported yet", async () => {
      render(<CombinedDiffTab input={combinedDiffInput({ items: many(60), reveal: "/r/src/File40.ts" })} />);
      await act(() => new Promise((r) => setTimeout(r, 50)));
      const el = document.querySelector<HTMLElement>("[data-combined-scroll]")!;
      // The wheel moved the view, its scroll event not dispatched yet.
      const scrolled = el.scrollTop - 200;
      el.scrollTop = scrolled;
      grow(38, 1000);
      expect(el.scrollTop).toBe(scrolled + 400);
    });
  });

  it("keeps the focused block mounted when it is scrolled away", () => {
    render(<CombinedDiffTab input={combinedDiffInput({ items: many(30) })} />);
    act(() => screen.getAllByRole("button", { name: "Collapse File" })[0]!.focus());
    for (let i = 0; i < 5; i++) scrollBy(600);
    // Its neighbours went, it stayed, still holding the focus.
    expect(mounted()).not.toContain("/r/src/File1.ts");
    expect(mounted()).toContain("/r/src/File0.ts");
    expect(document.querySelector('[data-combined-block="/r/src/File0.ts"]')).toBe(
      document.activeElement!.closest("[data-combined-block]"),
    );
  });

  it("shows both entries of a partially staged file, each collapsing on its own", () => {
    const path = "/r/src/Partial.ts";
    const staged = diff(path, { right: { type: "rev", rev: ":0" } });
    const unstaged = diff(path, { left: { type: "rev", rev: ":0" } });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<CombinedDiffTab input={combinedDiffInput({ items: [staged, unstaged] })} />);
    expect(screen.getAllByTestId("block-diff")).toHaveLength(2);
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Collapse File" })[0]!);
    });
    expect(screen.getAllByRole("button", { name: "Expand File" })).toHaveLength(1);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    error.mockRestore();
  });

  it("opens at the staged or the unstaged entry of a partially staged file, whichever was opened", async () => {
    setAllInOneDiff(true);
    const path = "/r/src/Partial.ts";
    const change = [
      diff(path, { right: { type: "rev", rev: ":0" } }),
      ...many(10),
      diff(path, { left: { type: "rev", rev: ":0" } }),
      ...many(10).map((d) => ({ ...d, path: d.path.replace("File", "Other") })),
    ];
    const topIndex = () => {
      const el = document.querySelector<HTMLElement>("[data-combined-scroll]")!;
      const slot = [...el.querySelectorAll<HTMLElement>("[data-index]")].find(
        (s) => Number.parseFloat(s.style.top) === el.scrollTop,
      );
      return Number(slot?.dataset.index);
    };
    const openAt = async (at: number) => {
      openInput.mockClear();
      await openDiff(withChain(change, at));
      const { unmount } = render(<CombinedDiffTab input={openInput.mock.calls[0]![0]} />);
      await act(() => new Promise((r) => setTimeout(r, 50)));
      const top = topIndex();
      unmount();
      return top;
    };
    expect(await openAt(0)).toBe(0);
    expect(await openAt(11)).toBe(11);
  });
});
