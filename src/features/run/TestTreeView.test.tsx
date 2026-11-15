import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { ContextMenuHost } from "@/ui";
import { occurrenceNavigator } from "@/workbench/contributions";
import { TestResults } from "./testing";
import { TestTreeView } from "./TestTreeView";
import { testTree } from "./testTree";

const nav = vi.hoisted(() => ({ openTarget: vi.fn(async () => {}) }));
vi.mock("./navigate", () => nav);
const actions = vi.hoisted(() => ({ executeAction: vi.fn(async () => {}) }));
vi.mock("@/platform/actions", async (orig) => ({ ...(await orig<object>()), executeAction: actions.executeAction }));

function results() {
  const r = new TestResults();
  r.apply([
    { type: "result", path: ["MathTest", "adds()"], status: "passed" },
    { type: "result", path: ["MathTest", "subs()"], status: "failed" },
    {
      type: "output",
      path: ["MathTest", "subs()"],
      line: "org.opentest4j.AssertionFailedError: expected: <1> but was: <2>",
    },
    { type: "location", path: ["MathTest", "subs()"], location: { path: "MathTest.java", line: 9, resolve: "name" } },
  ]);
  r.finish(1);
  return r;
}

function Host(props: {
  onRunTests?: (ids: string[], debug: boolean) => void;
  canRunTests?: (ids: string[]) => boolean | Promise<boolean>;
}) {
  return (
    <>
      <TestTreeView
        results={results()}
        version={1}
        cwd="/p"
        selected={null}
        onSelect={() => {}}
        running={false}
        {...props}
      />
      <ContextMenuHost />
    </>
  );
}

describe("TestTreeView", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.clearAllMocks());

  it("hides passed tests by default and remembers the toggle", () => {
    const { unmount } = render(<Host />);
    expect(screen.queryByText("adds()")).toBeNull();
    expect(screen.getByText("subs()")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Passed" }));
    expect(screen.getByText("adds()")).toBeTruthy();
    unmount();
    render(<Host />);
    expect(screen.getByText("adds()")).toBeTruthy();
  });

  it("a click selects without navigating; double-click jumps to the source", () => {
    render(<Host />);
    fireEvent.mouseDown(screen.getByText("subs()"));
    fireEvent.click(screen.getByText("subs()"));
    expect(nav.openTarget).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText("subs()"));
    expect(nav.openTarget).toHaveBeenCalledWith(
      expect.objectContaining({ path: "MathTest.java", line: 9 }),
      "/p",
      true,
    );
  });

  it("context menu: Run / Debug the test and Show Diff of an assertion failure", () => {
    const onRunTests = vi.fn();
    render(<Host onRunTests={onRunTests} />);
    fireEvent.contextMenu(screen.getByText("subs()"));
    fireEvent.click(screen.getByText("Debug 'subs()'"));
    expect(onRunTests).toHaveBeenCalledWith(["MathTest\u0000subs()"], true);
    fireEvent.contextMenu(screen.getByText("subs()"));
    fireEvent.click(screen.getByText("Show Diff"));
    expect(actions.executeAction).toHaveBeenCalledWith(
      "diff.compareTexts",
      expect.objectContaining({ left: { text: "1", label: "Expected" }, right: { text: "2", label: "Actual" } }),
    );
  });

  it.each([true, false])(
    "enables Run and Debug only when the async selector returns support (%s)",
    async (supported) => {
      let resolve!: (supported: boolean) => void;
      const selection = new Promise<boolean>((done) => {
        resolve = done;
      });
      const canRunTests = vi.fn(() => selection);
      const onRunTests = vi.fn();
      render(<Host onRunTests={onRunTests} canRunTests={canRunTests} />);
      fireEvent.contextMenu(screen.getByText("subs()"));
      expect(screen.getByRole("menuitem", { name: "Run 'subs()'" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("menuitem", { name: "Debug 'subs()'" })).toHaveAttribute("aria-disabled", "true");
      expect(canRunTests).toHaveBeenCalledWith(["MathTest\u0000subs()"]);
      await act(async () => resolve(supported));
      for (const label of ["Run 'subs()'", "Debug 'subs()'"]) {
        expect(screen.getByRole("menuitem", { name: label }).hasAttribute("aria-disabled")).toBe(!supported);
      }
      if (supported) {
        fireEvent.click(screen.getByText("Run 'subs()'"));
        expect(onRunTests).toHaveBeenCalledWith(["MathTest\u0000subs()"], false);
      }
    },
  );
});

describe("Previous / Next Failed Test", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.clearAllMocks());

  /** Two suites with failures in a nested suite and between passing tests. */
  function nested(failures = true) {
    const r = new TestResults();
    const bad = failures ? "failed" : "passed";
    r.apply([
      { type: "result", path: ["ApiTest", "lists()"], status: "passed" },
      { type: "result", path: ["ApiTest", "Auth", "rejects()"], status: bad },
      { type: "result", path: ["ApiTest", "Auth", "accepts()"], status: "passed" },
      { type: "result", path: ["DbTest", "reads()"], status: bad },
      { type: "result", path: ["DbTest", "skips()"], status: "skipped" },
      { type: "result", path: ["DbTest", "writes()"], status: bad },
      { type: "location", path: ["DbTest", "writes()"], location: { path: "DbTest.java", line: 20, resolve: "name" } },
    ]);
    r.finish(failures ? 1 : 0);
    return r;
  }

  function Nested({ results }: { results: TestResults }) {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <TestTreeView results={results} version={1} cwd="/p" selected={selected} onSelect={setSelected} running={false} />
    );
  }

  const go = (dir: 1 | -1, focus = false) => {
    let step: ReturnType<NonNullable<ReturnType<typeof occurrenceNavigator>>["go"]> = null;
    act(() => {
      step = occurrenceNavigator("run")!.go(dir, focus);
    });
    return step as { key: string; index: number; total: number } | null;
  };
  const selectedName = () => screen.getByRole("treeitem", { selected: true }).textContent;
  const prev = () => screen.getByRole("button", { name: "Previous Failed Test" });
  const next = () => screen.getByRole("button", { name: "Next Failed Test" });

  it("steps through the failed tests in tree order and stops at both ends", () => {
    render(<Nested results={nested()} />);
    expect(prev()).toBeEnabled();
    expect(next()).toBeEnabled();
    expect(go(1)).toMatchObject({ index: 1, total: 3 });
    expect(selectedName()).toContain("rejects()");
    expect(go(1)).toMatchObject({ index: 2, total: 3 });
    expect(selectedName()).toContain("reads()");
    expect(go(1)).toMatchObject({ index: 3, total: 3 });
    expect(selectedName()).toContain("writes()");
    // IDEA doesn't wrap: Next is unavailable on the last failure, and the selection stays.
    expect(next()).toBeDisabled();
    expect(prev()).toBeEnabled();
    expect(go(1)).toBeNull();
    expect(selectedName()).toContain("writes()");
    expect(go(-1)).toMatchObject({ index: 2 });
    expect(go(-1)).toMatchObject({ index: 1 });
    expect(prev()).toBeDisabled();
    expect(go(-1)).toBeNull();
    expect(selectedName()).toContain("rejects()");
  });

  it("expands the collapsed suites of the failure it selects", () => {
    render(<Nested results={nested()} />);
    const suite = screen.getByText("ApiTest").closest('[role="treeitem"]')!;
    fireEvent.mouseDown(suite.querySelector("[data-tree-toggle]")!, { button: 0 });
    expect(screen.queryByText("rejects()")).toBeNull();
    go(1);
    expect(selectedName()).toContain("rejects()");
  });

  it("opens the failure's source, focusing the editor only when asked", () => {
    render(<Nested results={nested()} />);
    go(-1);
    expect(nav.openTarget).toHaveBeenCalledWith(
      expect.objectContaining({ path: "DbTest.java", line: 20 }),
      "/p",
      false,
    );
    go(-1, true);
    // reads() has no location: nothing to open.
    expect(nav.openTarget).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when no test failed", () => {
    render(<Nested results={nested(false)} />);
    expect(prev()).toBeDisabled();
    expect(next()).toBeDisabled();
    expect(go(1)).toBeNull();
    expect(go(-1)).toBeNull();
  });

  it("runs Previous / Next Occurrence, so ⌘⌥↑ / ⌘⌥↓ do the same", () => {
    render(<Nested results={nested()} />);
    fireEvent.click(next());
    expect(actions.executeAction).toHaveBeenCalledWith("navigate.nextOccurrence", undefined);
    fireEvent.click(prev());
    expect(actions.executeAction).toHaveBeenCalledWith("navigate.prevOccurrence", undefined);
  });
});

describe("Expand All / Collapse All", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.clearAllMocks());

  function nested() {
    const r = new TestResults();
    r.apply([
      { type: "result", path: ["ApiTest", "Auth", "Tokens", "refreshes()"], status: "failed" },
      { type: "result", path: ["ApiTest", "Users", "lists()"], status: "passed" },
      { type: "result", path: ["DbTest", "Pool", "reuses()"], status: "passed" },
    ]);
    r.finish(1);
    return r;
  }

  const view = (results: TestResults) => (
    <TestTreeView results={results} version={1} cwd="/p" selected={null} onSelect={() => {}} running={false} />
  );
  const rows = () => screen.queryAllByRole("treeitem").map((r) => r.textContent?.replace(/\d+ ms$/, ""));

  it("opens every suite, including those of hidden passed tests, and folds back to the top-level suites", () => {
    localStorage.setItem("openidea.run.testFilters", JSON.stringify({ showPassed: true }));
    render(view(nested()));
    // By default only the top level and the suites with failures are open.
    expect(rows()).toEqual(["ApiTest", "Auth", "Tokens", "refreshes()", "Users", "DbTest", "Pool"]);
    act(() => testTree.expandAll!());
    expect(rows()).toEqual([
      "ApiTest",
      "Auth",
      "Tokens",
      "refreshes()",
      "Users",
      "lists()",
      "DbTest",
      "Pool",
      "reuses()",
    ]);
    act(() => testTree.collapseAll!());
    expect(rows()).toEqual(["ApiTest", "DbTest"]);
    // Expanded state survives a filter change.
    act(() => testTree.expandAll!());
    fireEvent.click(screen.getByRole("button", { name: "Show Passed" }));
    expect(rows()).toEqual(["ApiTest", "Auth", "Tokens", "refreshes()"]);
    fireEvent.click(screen.getByRole("button", { name: "Show Passed" }));
    expect(rows()).toContain("reuses()");
  });

  it("the buttons run the actions, and are unavailable without suites", () => {
    const dispose = registerActions([
      { id: "run.expandAllTests", title: "Expand All", run: () => {} },
      { id: "run.collapseAllTests", title: "Collapse All", run: () => {} },
    ]);
    onTestFinished(dispose);
    const { unmount } = render(view(nested()));
    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    expect(actions.executeAction).toHaveBeenCalledWith("run.expandAllTests", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Collapse All" }));
    expect(actions.executeAction).toHaveBeenCalledWith("run.collapseAllTests", undefined);
    unmount();
    expect(testTree.expandAll).toBeNull();

    const flat = new TestResults();
    flat.apply([{ type: "result", path: ["main_test"], status: "failed" }]);
    flat.finish(1);
    render(view(flat));
    expect(screen.getByRole("button", { name: "Expand All" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Collapse All" })).toBeDisabled();
  });
});
