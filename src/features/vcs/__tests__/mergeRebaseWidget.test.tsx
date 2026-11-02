import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MergeRebaseWidget } from "../MergeRebaseWidget";
import { useVcs } from "../store";

describe("MergeRebaseWidget", () => {
  afterEach(() => {
    cleanup();
    useVcs.setState({ status: [], branch: null });
  });

  it("renders nothing without conflicts or an operation", () => {
    const { container } = render(<MergeRebaseWidget />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers only Resolve for conflicts left without an operation (stash pop)", () => {
    useVcs.setState({ status: [{ path: "a", unstaged: "conflicted" } as never] });
    render(<MergeRebaseWidget />);
    expect(screen.getByLabelText("Resolve Conflicts…")).toBeTruthy();
    expect(screen.queryByLabelText(/Abort/)).toBeNull();
  });

  it("offers Continue and Abort for a rebase with nothing left to resolve", () => {
    useVcs.setState({ branch: { head: "x", operation: "rebase" } as never });
    render(<MergeRebaseWidget />);
    expect(screen.getByLabelText("Continue Rebase")).toBeTruthy();
    expect(screen.getByLabelText("Abort Rebase")).toBeTruthy();
  });
});
