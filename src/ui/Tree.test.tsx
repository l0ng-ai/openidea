import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Tree, type TreeHandle } from "./Tree";
import { getContext } from "@/platform/context";

interface N {
  id: string;
  children?: N[];
}

const data: N[] = [
  {
    id: "src",
    children: [{ id: "main", children: [{ id: "App.tsx" }, { id: "index.ts" }] }, { id: "util.ts" }],
  },
  { id: "README.md" },
];

function setup(props: Partial<React.ComponentProps<typeof Tree<N>>> = {}) {
  const onActivate = vi.fn();
  const utils = render(
    <Tree<N>
      aria-label="Files"
      roots={data}
      getKey={(n) => n.id}
      getLabel={(n) => n.id}
      getChildren={(n) => n.children}
      isExpandable={(n) => !!n.children}
      onActivate={onActivate}
      {...props}
    />,
  );
  const tree = screen.getByRole("tree");
  tree.focus();
  const lead = () => {
    const id = tree.getAttribute("aria-activedescendant");
    return id ? document.getElementById(id)?.textContent : null;
  };
  const key = (k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(tree, { key: k, ...init });
  return { ...utils, tree, lead, key, onActivate };
}

const labels = (tree: HTMLElement) =>
  within(tree)
    .queryAllByRole("treeitem")
    .map((el) => el.textContent);

describe("Tree directory context", () => {
  it("does not contribute virtual document URIs as filesystem directories", () => {
    const { key } = setup({ getDirectory: () => "jdt://contents/library.jar/package" });
    key("Home");
    expect(getContext().focusedDirectory).toBeUndefined();
  });

  it("follows the selected lead, clears on non-path rows, blur and unmount", () => {
    const { tree, key, unmount } = setup({
      getDirectory: (n) => (n.id === "main" ? null : `/p/${n.id}`),
    });
    expect(getContext().focusedDirectory).toBeUndefined();
    key("ArrowDown");
    expect(getContext().focusedDirectory).toBe("/p/src");
    key("End", { shiftKey: true });
    expect(getContext().focusedDirectory).toBe("/p/README.md");
    key("Home");
    key("ArrowRight");
    key("ArrowRight");
    expect(getContext().focusedDirectory).toBeUndefined();
    key("Home");
    fireEvent.blur(tree);
    expect(getContext().focusedDirectory).toBeUndefined();
    fireEvent.focus(tree);
    expect(getContext().focusedDirectory).toBe("/p/src");
    unmount();
    expect(getContext().focusedDirectory).toBeUndefined();
  });

  it("updates a controlled selection while focused and clears a removed selection", () => {
    const view = (selected: Set<string>, roots = data) => (
      <Tree<N>
        roots={roots}
        getKey={(n) => n.id}
        getLabel={(n) => n.id}
        getChildren={(n) => n.children}
        isExpandable={(n) => !!n.children}
        selected={selected}
        getDirectory={(n) => `/p/${n.id}`}
      />
    );
    const { rerender } = render(view(new Set(["src"])));
    screen.getByRole("tree").focus();
    expect(getContext().focusedDirectory).toBe("/p/src");
    rerender(view(new Set()));
    expect(getContext().focusedDirectory).toBeUndefined();
    rerender(view(new Set(["src"])));
    expect(getContext().focusedDirectory).toBe("/p/src");
    rerender(view(new Set(["src"]), []));
    expect(getContext().focusedDirectory).toBeUndefined();
  });

  it("clears on focus transfer and an old tree's unmount does not clear the new owner", () => {
    const view = (showFirst: boolean) => (
      <>
        {showFirst && (
          <Tree<N>
            roots={data}
            getKey={(n) => n.id}
            getLabel={(n) => n.id}
            getChildren={() => []}
            isExpandable={() => false}
            defaultSelected={["src"]}
            getDirectory={() => "/first"}
          />
        )}
        <Tree<N>
          roots={data}
          getKey={(n) => n.id}
          getLabel={(n) => n.id}
          getChildren={() => []}
          isExpandable={() => false}
          defaultSelected={["src"]}
          getDirectory={() => "/second"}
        />
        <input aria-label="Editor" />
      </>
    );
    const { rerender } = render(view(true));
    const [first, second] = screen.getAllByRole("tree");
    first!.focus();
    expect(getContext().focusedDirectory).toBe("/first");
    second!.focus();
    expect(getContext().focusedDirectory).toBe("/second");
    rerender(view(false));
    expect(getContext().focusedDirectory).toBe("/second");
    screen.getByLabelText("Editor").focus();
    expect(getContext().focusedDirectory).toBeUndefined();
  });
});

describe("Tree keyboard navigation", () => {
  it("moves with arrows, expands with Right and collapses / goes to parent with Left", () => {
    const { tree, lead, key } = setup();
    expect(labels(tree)).toEqual(["src", "README.md"]);
    key("ArrowDown");
    expect(lead()).toBe("src");
    key("ArrowRight");
    expect(labels(tree)).toEqual(["src", "main", "util.ts", "README.md"]);
    key("ArrowRight");
    expect(lead()).toBe("main");
    key("ArrowRight");
    key("ArrowDown");
    expect(lead()).toBe("App.tsx");
    key("ArrowLeft");
    expect(lead()).toBe("main");
    key("ArrowLeft");
    expect(labels(tree)).toEqual(["src", "main", "util.ts", "README.md"]);
    key("End");
    expect(lead()).toBe("README.md");
    key("Home");
    expect(lead()).toBe("src");
  });

  it("Enter toggles folders and activates leaves", () => {
    const { tree, lead, key, onActivate } = setup();
    key("ArrowDown");
    key("Enter");
    expect(labels(tree)).toContain("main");
    key("End");
    expect(lead()).toBe("README.md");
    key("Enter");
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "README.md" }), expect.anything());
  });

  it("F4 and ⌘↓ activate like Enter (Jump to Source)", () => {
    const { key, onActivate } = setup();
    key("End");
    key("F4");
    expect(onActivate).toHaveBeenCalledTimes(1);
    key("ArrowDown", { metaKey: true });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "README.md" }), expect.anything());
  });

  it("extends the selection with Shift+Arrow", () => {
    const onSelectionChange = vi.fn();
    const { key } = setup({ defaultExpanded: ["src"], onSelectionChange });
    key("ArrowDown");
    key("ArrowDown", { shiftKey: true });
    key("ArrowDown", { shiftKey: true });
    const last = onSelectionChange.mock.calls.at(-1)![0] as Set<string>;
    expect([...last].sort()).toEqual(["main", "src", "util.ts"]);
  });

  it("lazy-loads children on expand", () => {
    const loadChildren = vi.fn();
    const { tree, key } = setup({ getChildren: () => undefined, loadChildren });
    key("ArrowDown");
    key("ArrowRight");
    expect(loadChildren).toHaveBeenCalledWith(expect.objectContaining({ id: "src" }));
    expect(tree.textContent).toContain("Loading");
  });
});

describe("Tree speed search", () => {
  it("jumps to and highlights matches, cycles with arrows and clears with Escape", () => {
    const { tree, lead, key } = setup({ defaultExpanded: ["src", "main"] });
    key("ArrowDown");
    key("i");
    key("n");
    key("d");
    expect(lead()).toBe("index.ts");
    expect(screen.getByRole("status")).toHaveTextContent("ind");
    expect([...tree.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["ind"]);
    key("Backspace");
    // "in" matches "main" (above) and "index.ts": arrows cycle between matches.
    key("ArrowUp");
    expect(lead()).toBe("main");
    key("ArrowDown");
    expect(lead()).toBe("index.ts");
    key("ArrowDown");
    expect(lead()).toBe("main");
    key("Escape");
    expect(screen.queryByRole("status")).toBeNull();
    expect(tree.querySelectorAll("mark")).toHaveLength(0);
  });

  it("Home / End jump to the first / last match; Left closes the search and collapses", () => {
    const { tree, lead, key } = setup({ defaultExpanded: ["src", "main"] });
    key("ArrowDown");
    key("t");
    key("s");
    // "ts" matches App.tsx, index.ts and util.ts.
    key("End");
    expect(lead()).toBe("util.ts");
    key("Home");
    expect(lead()).toBe("App.tsx");
    key("ArrowLeft");
    expect(screen.queryByRole("status")).toBeNull();
    expect(lead()).toBe("main");
    expect(labels(tree)).toContain("App.tsx");
  });

  it("filter mode hides non-matching rows but keeps ancestors", () => {
    const { tree, key } = setup({ defaultExpanded: ["src", "main"], speedSearchMode: "filter" });
    key("ArrowDown");
    for (const c of "App") key(c);
    expect(labels(tree)).toEqual(["src", "main", "App.tsx"]);
  });
});

describe("Tree occurrences", () => {
  it("selects the next / previous leaf, expanding its ancestors", () => {
    const handle = createRef<TreeHandle>();
    const onSelectionChange = vi.fn();
    const { tree, lead } = setup({ handleRef: handle, onSelectionChange });
    let step: ReturnType<TreeHandle["selectOccurrence"]> = null;
    act(() => void (step = handle.current!.selectOccurrence(1)));
    expect(step).toMatchObject({ key: "App.tsx", index: 1, total: 4 });
    expect(labels(tree)).toEqual(["src", "main", "App.tsx", "index.ts", "util.ts", "README.md"]);
    expect(lead()).toBe("App.tsx");
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      new Set(["App.tsx"]),
      expect.objectContaining({ id: "App.tsx" }),
    );
    act(() => void (step = handle.current!.selectOccurrence(1)));
    expect(step).toMatchObject({ key: "index.ts", index: 2 });
    act(() => void (step = handle.current!.selectOccurrence(-1)));
    expect(step).toMatchObject({ key: "App.tsx", index: 1 });
    act(() => void (step = handle.current!.selectOccurrence(-1)));
    expect(step).toBeNull();
    expect(lead()).toBe("App.tsx");
  });

  it("starts from the selected group and honours isOccurrence", () => {
    const handle = createRef<TreeHandle>();
    const { key } = setup({ handleRef: handle, isOccurrence: (n) => n.id !== "src" });
    key("ArrowDown"); // src
    let step: ReturnType<TreeHandle["selectOccurrence"]> = null;
    act(() => void (step = handle.current!.selectOccurrence(1)));
    expect(step).toMatchObject({ key: "main", index: 1, total: 5 });
    act(() => void (step = handle.current!.selectOccurrence(-1)));
    expect(step).toBeNull();
  });

  it("skips the lead's subtree on request", () => {
    const handle = createRef<TreeHandle>();
    const { key } = setup({ handleRef: handle, defaultExpanded: ["src"] });
    key("ArrowDown");
    key("ArrowDown"); // main
    let step: ReturnType<TreeHandle["selectOccurrence"]> = null;
    act(() => void (step = handle.current!.selectOccurrence(1, { skipSubtree: true })));
    expect(step).toMatchObject({ key: "util.ts", index: 3 });
  });
});

describe("siblingPositions", () => {
  it("numbers rows among siblings", async () => {
    const { siblingPositions } = await import("./Tree");
    expect(
      siblingPositions([{ parentKey: null }, { parentKey: "a" }, { parentKey: "a" }, { parentKey: null }]),
    ).toEqual([
      [1, 2],
      [1, 2],
      [2, 2],
      [2, 2],
    ]);
  });
});

describe("Tree horizontal scrolling", () => {
  const spacer = (tree: HTMLElement) => tree.querySelector<HTMLElement>("[data-content-width]");

  it("is off unless asked for", () => {
    const { tree } = setup();
    expect(spacer(tree)).toBeNull();
  });

  it("remeasures mounted rows with the same key, including narrower content", () => {
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(640);
    try {
      const { tree, key } = setup({ horizontalScroll: true, defaultExpanded: ["src"] });
      expect(spacer(tree)?.style.width).toBe("640px");
      width.mockReturnValue(100);
      key("ArrowDown");
      expect(spacer(tree)?.style.width).toBe("100px");
    } finally {
      width.mockRestore();
    }
  });

  it("removes widths belonging to collapsed descendants", () => {
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.textContent === "util.ts" ? 640 : 100;
    });
    try {
      const { tree, key } = setup({ horizontalScroll: true, defaultExpanded: ["src"] });
      expect(spacer(tree)?.style.width).toBe("640px");
      key("Home");
      key("ArrowLeft");
      expect(spacer(tree)?.style.width).toBe("100px");
    } finally {
      width.mockRestore();
    }
  });

  it("measures without the viewport minimum and restores it before returning", () => {
    const minimums: string[] = [];
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.hasAttribute("data-row")) minimums.push(this.style.minWidth);
      return parseFloat(this.style.minWidth) === 0 ? 100 : 800;
    });
    try {
      const { tree } = setup({ horizontalScroll: true });
      expect(spacer(tree)?.style.width).toBe("100px");
      expect(minimums.length).toBeGreaterThan(0);
      expect(minimums.every((value) => parseFloat(value) === 0)).toBe(true);
      for (const row of tree.querySelectorAll<HTMLElement>("[data-row]")) expect(row.style.minWidth).toBe("");
    } finally {
      width.mockRestore();
    }
  });
});
