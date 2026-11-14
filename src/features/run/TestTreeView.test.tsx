import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenuHost } from "@/ui";
import { TestResults } from "./testing";
import { TestTreeView } from "./TestTreeView";

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
