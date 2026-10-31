import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { getContext } from "@/platform/context";
import { ChangesTree } from "../CommitView";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

beforeEach(() => {
  useVcs.setState({
    root: "/p",
    roots: ["/p"],
    status: [
      {
        path: "/p/documents/note.txt",
        relPath: "documents/note.txt",
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
    ],
  });
  useCommit.setState({ groupByDir: true, checks: new Map(), selection: [] });
});

describe.each(["commit", "local", "dialog"] as const)("%s change tree directory", (mode) => {
  it("scopes folders and file parents, and clears on groups and message focus", () => {
    render(
      <>
        <ChangesTree mode={mode} />
        <textarea aria-label="Commit message" />
      </>,
    );
    const tree = screen.getByRole("tree", { name: "Changes" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "Home" });
    expect(getContext().focusedDirectory).toBeUndefined();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(getContext().focusedDirectory).toBe("/p/documents");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(getContext().focusedDirectory).toBe("/p/documents");
    screen.getByLabelText("Commit message").focus();
    expect(getContext().focusedDirectory).toBeUndefined();
  });
});
