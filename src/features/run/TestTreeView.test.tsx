import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { ContextMenuHost } from "@/ui";
import { occurrenceNavigator } from "@/workbench/contributions";
import { TestResults } from "./testing";
import { TestTreeView } from "./TestTreeView";
import { testTree } from "./testTree";

const nav = vi.hoisted(() => ({
  openTarget: vi.fn(async () => {}),
  resolveTarget: vi.fn(async () => "/p/src/test/java/MathTest.java"),
}));
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

function moreItem(name: string | RegExp) {
  const trigger = screen.getByRole("button", { name: "More Actions" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.getByRole("menuitem", { name });
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

  it("context menu: Diagnose with Agent passes the selected failure to the agents action (#4716)", async () => {
    // Offered only while the agents feature provides the action.
    render(<Host />);
    fireEvent.contextMenu(screen.getByText("subs()"));
    expect(screen.queryByText("Diagnose with Agent")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    onTestFinished(
      registerActions([{ id: "agents.diagnoseTestFailure", title: "Diagnose with Agent", run: () => {} }]),
    );
    // A suite is not one test.
    fireEvent.contextMenu(screen.getByText("MathTest"));
    expect(screen.queryByText("Diagnose with Agent")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.contextMenu(screen.getByText("subs()"));
    await act(async () => fireEvent.click(screen.getByText("Diagnose with Agent")));
    expect(actions.executeAction).toHaveBeenCalledWith("agents.diagnoseTestFailure", {
      name: "subs()",
      path: "/p/src/test/java/MathTest.java",
      line: 9,
      expected: "1",
      actual: "2",
      output: ["org.opentest4j.AssertionFailedError: expected: <1> but was: <2>"],
    });
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
  const navigate = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    onTestFinished(
      registerActions([
        { id: "navigate.prevOccurrence", title: "Previous Occurrence", run: () => void navigate(-1) },
        { id: "navigate.nextOccurrence", title: "Next Occurrence", run: () => void navigate(1) },
      ]),
    );
  });
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
  const prev = () => moreItem(/^Previous Failed Test/);
  const next = () => moreItem(/^Next Failed Test/);

  it("steps through the failed tests in tree order and stops at both ends", () => {
    render(<Nested results={nested()} />);
    expect(prev()).not.toHaveAttribute("aria-disabled", "true");
    expect(next()).not.toHaveAttribute("aria-disabled", "true");
    expect(go(1)).toMatchObject({ index: 1, total: 3 });
    expect(selectedName()).toContain("rejects()");
    expect(go(1)).toMatchObject({ index: 2, total: 3 });
    expect(selectedName()).toContain("reads()");
    expect(go(1)).toMatchObject({ index: 3, total: 3 });
    expect(selectedName()).toContain("writes()");
    // IDEA doesn't wrap: Next is unavailable on the last failure, and the selection stays.
    expect(next()).toHaveAttribute("aria-disabled", "true");
    expect(prev()).not.toHaveAttribute("aria-disabled", "true");
    expect(go(1)).toBeNull();
    expect(selectedName()).toContain("writes()");
    expect(go(-1)).toMatchObject({ index: 2 });
    expect(go(-1)).toMatchObject({ index: 1 });
    expect(prev()).toHaveAttribute("aria-disabled", "true");
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
    expect(prev()).toHaveAttribute("aria-disabled", "true");
    expect(next()).toHaveAttribute("aria-disabled", "true");
    expect(go(1)).toBeNull();
    expect(go(-1)).toBeNull();
  });

  it("runs Previous / Next Occurrence, so ⌘⌥↑ / ⌘⌥↓ do the same", () => {
    render(<Nested results={nested()} />);
    fireEvent.click(next());
    fireEvent.click(prev());
    expect(navigate.mock.calls).toEqual([[1], [-1]]);
  });
});

it("remembers hidden row durations across test result sessions", () => {
  localStorage.clear();
  onTestFinished(() => localStorage.clear());
  const results = new TestResults();
  results.apply([{ type: "result", path: ["TestCheckout"], status: "failed", durationMs: 120 }]);
  results.finish(1);
  const view = (
    <TestTreeView results={results} version={1} cwd="/p" selected={null} onSelect={() => {}} running={false} />
  );
  const { unmount } = render(view);
  expect(screen.getByText("120 ms")).toBeVisible();
  act(() => testTree.toggleDurations!());
  expect(screen.queryByText("120 ms")).toBeNull();
  unmount();
  expect(testTree.toggleDurations).toBeNull();
  render(view);
  expect(screen.queryByText("120 ms")).toBeNull();
  expect(testTree.showDurations).toBe(false);
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

  it("the menu runs the actions, and they are unavailable without suites", () => {
    const dispose = registerActions([
      { id: "run.expandAllTests", title: "Expand All", run: () => {} },
      { id: "run.collapseAllTests", title: "Collapse All", run: () => {} },
    ]);
    onTestFinished(dispose);
    const { unmount } = render(view(nested()));
    fireEvent.click(moreItem("Expand All"));
    expect(actions.executeAction).toHaveBeenCalledWith("run.expandAllTests");
    fireEvent.click(moreItem("Collapse All"));
    expect(actions.executeAction).toHaveBeenCalledWith("run.collapseAllTests");
    unmount();
    expect(testTree.expandAll).toBeNull();

    const flat = new TestResults();
    flat.apply([{ type: "result", path: ["main_test"], status: "failed" }]);
    flat.finish(1);
    render(view(flat));
    expect(moreItem("Expand All")).toHaveAttribute("aria-disabled", "true");
    expect(moreItem("Collapse All")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Export Test Results", () => {
  function finished() {
    const r = new TestResults();
    r.apply([{ type: "result", path: ["calc", "TestAdd"], status: "passed" }]);
    r.finish(0);
    return r;
  }
  const view = (results: TestResults, running: boolean) => (
    <TestTreeView
      results={results}
      version={1}
      cwd="/p"
      name="calc tests"
      selected={null}
      onSelect={() => {}}
      running={running}
    />
  );

  it("the menu and the action open the dialog for the finished run", () => {
    const { unmount } = render(view(finished(), false));
    fireEvent.click(moreItem("Export Test Results…"));
    expect(screen.getByRole("dialog", { name: "Export Test Results" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => testTree.exportResults!());
    expect(screen.getByRole("dialog", { name: "Export Test Results" })).toBeInTheDocument();
    expect(screen.getByLabelText("Output file")).toHaveValue("/p/Test Results - calc tests.html");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Export Test Results" })).toBeNull();
    unmount();
    expect(testTree.exportResults).toBeNull();
  });

  it("is unavailable while the tests run and without results", () => {
    const { rerender } = render(view(finished(), true));
    expect(moreItem("Export Test Results…")).toHaveAttribute("aria-disabled", "true");
    expect(testTree.exportResults).toBeNull();
    rerender(view(new TestResults(), false));
    expect(moreItem("Export Test Results…")).toHaveAttribute("aria-disabled", "true");
    expect(testTree.exportResults).toBeNull();
    rerender(view(finished(), false));
    expect(moreItem("Export Test Results…")).not.toHaveAttribute("aria-disabled", "true");
    expect(testTree.exportResults).not.toBeNull();
  });
});

describe("Sorting Options", () => {
  beforeEach(() => localStorage.setItem("openidea.run.testFilters", JSON.stringify({ showPassed: true })));
  afterEach(() => localStorage.clear());

  /** Run order: beta (item10, Item2, item1), Alpha (zeta); item1 reported no duration. */
  function timed() {
    const r = new TestResults();
    r.apply([
      { type: "result", path: ["beta", "item10()"], status: "passed", durationMs: 5 },
      { type: "result", path: ["beta", "Item2()"], status: "passed", durationMs: 30 },
      { type: "result", path: ["beta", "item1()"], status: "failed" },
      { type: "result", path: ["Alpha", "zeta()"], status: "passed", durationMs: 100 },
    ]);
    r.finish(1);
    return r;
  }
  const view = (results: TestResults, running = false) => (
    <TestTreeView results={results} version={1} cwd="/p" selected={null} onSelect={() => {}} running={running} />
  );
  const rows = () => screen.getAllByRole("treeitem").map((el) => el.textContent!.replace(/[\d.]+ m?s$/, ""));
  const option = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Sorting Options" }));
    return screen.getByRole("menuitemcheckbox", { name });
  };

  it("keeps the run order until a sort is chosen", () => {
    render(view(timed()));
    expect(rows()).toEqual(["beta", "item10()", "Item2()", "item1()", "Alpha", "zeta()"]);
    expect(screen.getByRole("button", { name: "Sorting Options" })).toHaveAttribute("aria-pressed", "false");
  });

  it("Sort Alphabetically orders suites and tests by name, ignoring case and comparing numbers, and is remembered", () => {
    const { unmount } = render(view(timed()));
    fireEvent.click(option("Sort Alphabetically"));
    expect(rows()).toEqual(["Alpha", "zeta()", "beta", "item1()", "Item2()", "item10()"]);
    expect(screen.getByRole("button", { name: "Sorting Options" })).toHaveAttribute("aria-pressed", "true");
    unmount();
    render(view(timed()));
    expect(rows()).toEqual(["Alpha", "zeta()", "beta", "item1()", "Item2()", "item10()"]);
    fireEvent.click(option("Sort Alphabetically"));
    expect(rows()).toEqual(["beta", "item10()", "Item2()", "item1()", "Alpha", "zeta()"]);
  });

  it("Sort by Duration puts the slowest first at each level, tests without a duration last", () => {
    render(view(timed()));
    fireEvent.click(option("Sort by Duration"));
    expect(rows()).toEqual(["Alpha", "zeta()", "beta", "Item2()", "item10()", "item1()"]);
  });

  it("the two sorts replace each other, as in IDEA", () => {
    render(view(timed()));
    fireEvent.click(option("Sort by Duration"));
    expect(option("Sort by Duration")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Sort Alphabetically" }));
    expect(option("Sort Alphabetically")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Sort by Duration" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Sort by Duration" }));
    expect(rows()).toEqual(["Alpha", "zeta()", "beta", "Item2()", "item10()", "item1()"]);
    expect(option("Sort Alphabetically")).toHaveAttribute("aria-checked", "false");
  });

  it("a saved pair of sorts loads as Sort by Duration alone", () => {
    localStorage.setItem(
      "openidea.run.testFilters",
      JSON.stringify({ showPassed: true, sortAlphabetically: true, sortByDuration: true }),
    );
    render(view(timed()));
    expect(rows()).toEqual(["Alpha", "zeta()", "beta", "Item2()", "item10()", "item1()"]);
    expect(option("Sort Alphabetically")).toHaveAttribute("aria-checked", "false");
  });

  it("the button opens and closes the menu", () => {
    render(view(timed()));
    const button = screen.getByRole("button", { name: "Sorting Options" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitemcheckbox", { name: "Sort by Duration" })).toBeNull();
  });

  it("Sort by Duration waits for the run to finish", () => {
    localStorage.setItem("openidea.run.testFilters", JSON.stringify({ showPassed: true, sortByDuration: true }));
    const { rerender } = render(view(timed(), true));
    expect(rows()).toEqual(["beta", "item10()", "Item2()", "item1()", "Alpha", "zeta()"]);
    expect(option("Sort by Duration")).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    rerender(view(timed(), false));
    expect(rows()).toEqual(["Alpha", "zeta()", "beta", "Item2()", "item10()", "item1()"]);
  });

  it("Previous / Next Failed Test follow the sorted order", () => {
    const r = new TestResults();
    r.apply([
      { type: "result", path: ["s", "b()"], status: "failed" },
      { type: "result", path: ["s", "a()"], status: "failed" },
    ]);
    r.finish(1);
    function Selecting() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <TestTreeView results={r} version={1} cwd="/p" selected={selected} onSelect={setSelected} running={false} />
      );
    }
    render(<Selecting />);
    fireEvent.click(option("Sort Alphabetically"));
    act(() => void occurrenceNavigator("run")!.go(1, false));
    expect(screen.getByRole("treeitem", { selected: true }).textContent).toBe("a()");
  });
});
