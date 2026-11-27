import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { FileStatus } from "@/bindings";
import { installKeyboardDispatcher, primaryKeyBinding } from "@/platform/keymap";
import { FileChecklist } from "../shelf";
import { useVcs } from "../store";

const openDiffDialog = vi.hoisted(() => vi.fn());
vi.mock("../diffDialog", () => ({ openDiffDialog }));

const file = (rel: string): FileStatus => ({
  path: `/repo/${rel}`,
  relPath: rel,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
});

const files = [
  file("src/chat/web/ChatApiController.java"),
  file("src/chat/web/ChatController.java"),
  file("src/chat/config/AiConfig.java"),
  file("pom.xml"),
];

function Harness() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(files.map((f) => f.path)));
  return <FileChecklist files={files} selected={selected} onChange={setSelected} label="Files to shelve" />;
}

const box = (name: string) => screen.getByRole("checkbox", { name: `Include ${name}` });

beforeEach(() => {
  useVcs.setState({ root: "/repo" });
  openDiffDialog.mockReset();
});
afterEach(cleanup);

it("groups the files by directory, merging single-child chains and counting files", () => {
  render(<Harness />);
  expect(screen.getByRole("tree", { name: "Files to shelve" })).toBeTruthy();
  expect(screen.getByText("repo")).toBeTruthy();
  expect(screen.getByText("4 files")).toBeTruthy();
  expect(screen.getByText("src/chat")).toBeTruthy();
  expect(screen.getByText("3 files")).toBeTruthy();
  expect(screen.getByText("web")).toBeTruthy();
  expect(screen.getByText("2 files")).toBeTruthy();
  expect(box("pom.xml")).toBeChecked();
});

it("checks or clears a directory's files at once and shows a partly included one as mixed", () => {
  render(<Harness />);
  fireEvent.click(box("ChatController.java"));
  expect(box("ChatController.java")).not.toBeChecked();
  expect(box("web")).toHaveAttribute("aria-checked", "mixed");
  expect(box("src/chat")).toHaveAttribute("aria-checked", "mixed");
  expect(box("repo")).toHaveAttribute("aria-checked", "mixed");
  fireEvent.click(box("web"));
  expect(box("ChatController.java")).toBeChecked();
  expect(box("web")).toHaveAttribute("aria-checked", "true");
  fireEvent.click(box("src/chat"));
  for (const name of ["ChatApiController.java", "ChatController.java", "AiConfig.java"])
    expect(box(name)).not.toBeChecked();
  expect(box("pom.xml")).toBeChecked();
});

it("shows a file's diff on double-click and ⌘D, and toggles inclusion with the box and Space", async () => {
  const off = installKeyboardDispatcher();
  try {
    render(<Harness />);
    const tree = screen.getByRole("tree", { name: "Files to shelve" });
    const binding = primaryKeyBinding("vcs.showDiff");
    expect(binding).toMatch(/^(Meta|Ctrl)\+D$/);
    const showDiffKey = { key: "d", code: "KeyD", metaKey: binding === "Meta+D", ctrlKey: binding === "Ctrl+D" };
    // Before any row is selected, Show Diff starts at the first file.
    fireEvent.keyDown(tree, showDiffKey);
    await waitFor(() =>
      expect(openDiffDialog).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/repo/src/chat/config/AiConfig.java" }),
      ),
    );
    openDiffDialog.mockClear();
    const pom = screen.getByText("pom.xml");
    fireEvent.mouseDown(pom, { button: 0 });
    fireEvent.doubleClick(pom);
    await waitFor(() =>
      expect(openDiffDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/repo/pom.xml",
          left: { type: "rev", rev: "HEAD" },
          right: { type: "worktree" },
          chain: expect.arrayContaining([expect.objectContaining({ path: "/repo/src/chat/config/AiConfig.java" })]),
        }),
      ),
    );
    expect(box("pom.xml")).toBeChecked();

    fireEvent.mouseDown(screen.getByText("ChatController.java"), { button: 0 });
    fireEvent.keyDown(tree, showDiffKey);
    await waitFor(() =>
      expect(openDiffDialog).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: "/repo/src/chat/web/ChatController.java" }),
      ),
    );
    expect(box("ChatController.java")).toBeChecked();

    fireEvent.mouseDown(screen.getByText("AiConfig.java"), { button: 0 });
    fireEvent.keyDown(tree, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(openDiffDialog).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: "/repo/src/chat/config/AiConfig.java" }),
      ),
    );
    expect(box("AiConfig.java")).toBeChecked();

    fireEvent.mouseDown(screen.getByText("ChatController.java"), { button: 0 });
    fireEvent.keyDown(tree, { key: " ", code: "Space" });
    expect(box("ChatController.java")).not.toBeChecked();
    fireEvent.keyDown(tree, { key: " ", code: "Space" });
    expect(box("ChatController.java")).toBeChecked();

    openDiffDialog.mockClear();
    fireEvent.click(box("pom.xml"));
    fireEvent.click(box("pom.xml"));
    fireEvent.doubleClick(box("pom.xml"));
    expect(box("pom.xml")).toBeChecked();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openDiffDialog).not.toHaveBeenCalled();
  } finally {
    off();
  }
});

it("compares the index with the working copy when asked for the unstaged side", async () => {
  render(<FileChecklist files={files} selected={new Set()} onChange={() => {}} label="Files" diffSide="unstaged" />);
  fireEvent.doubleClick(screen.getByText("pom.xml"));
  await waitFor(() =>
    expect(openDiffDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/repo/pom.xml",
        left: expect.objectContaining({ type: "rev", rev: ":0" }),
        right: expect.objectContaining({ type: "worktree" }),
      }),
    ),
  );
});
