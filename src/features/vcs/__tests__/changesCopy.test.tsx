import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import type { MenuItem } from "@/ui";
import type { ChangeNode } from "../changes";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

import { ChangesTree, copyChangePaths, nodeMenu } from "../CommitView";
import { useVcs } from "../store";

const file = (rel: string, unstaged: FileStatus["unstaged"] = "modified"): ChangeNode => {
  const f: FileStatus = { path: `/p/${rel}`, relPath: rel, staged: null, unstaged, renamedFrom: null };
  return { key: f.path, type: "file", label: rel, group: "changes", files: [f], path: f.path };
};

const item = (menu: MenuItem[], label: string) => {
  const i = menu.find((m) => m.kind !== "separator" && "label" in m && m.label === label);
  return i && "run" in i ? i : undefined;
};

const writeText = vi.hoisted(() => vi.fn());

describe("Copy in the changes tree (#1877)", () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useVcs.setState({
      available: true,
      root: "/p",
      repo: "/p",
      roots: ["/p"],
      status: [
        { path: "/p/src/a.ts", relPath: "src/a.ts", staged: null, unstaged: "modified", renamedFrom: null },
        { path: "/p/new.txt", relPath: "new.txt", staged: null, unstaged: "untracked", renamedFrom: null },
      ],
    });
  });

  it("copies names with Ctrl+C and absolute paths with Ctrl+Shift+C", async () => {
    render(<ChangesTree mode="commit" />);
    const row = (await screen.findByText("a.ts")).closest('[role="treeitem"]')!;
    act(() => fireEvent.mouseDown(row));
    // Tests run on the macOS keymap (jsdom UA is Macintosh): ⌘C / ⌘⇧C.
    act(() => fireEvent.keyDown(row, { key: "c", code: "KeyC", metaKey: true }));
    expect(writeText).toHaveBeenCalledWith("a.ts");
    act(() => fireEvent.keyDown(row, { key: "C", code: "KeyC", metaKey: true, shiftKey: true }));
    expect(writeText).toHaveBeenCalledWith("/p/src/a.ts");
  });

  it("copies the file names of every selected file of the unversioned group too", async () => {
    render(<ChangesTree mode="commit" />);
    // Unversioned Files starts collapsed; expand it via its chevron.
    const group = (await screen.findByText("Unversioned Files")).closest('[role="treeitem"]')!;
    act(() => fireEvent.mouseDown(group.querySelector("[data-tree-toggle]")!));
    const row = (await screen.findByText("new.txt")).closest('[role="treeitem"]')!;
    act(() => fireEvent.mouseDown(row));
    act(() => fireEvent.keyDown(row, { key: "c", code: "KeyC", metaKey: true }));
    expect(writeText).toHaveBeenCalledWith("new.txt");
  });

  it("offers Copy File Name beside Copy Path in the context menu", () => {
    const menu = nodeMenu([file("src/a.ts"), file("docs/b.md", "untracked")], ["/p"]);
    item(menu, "Copy File Name")?.run?.();
    expect(writeText).toHaveBeenCalledWith("a.ts\nb.md");
    item(menu, "Copy Path")?.run?.();
    expect(writeText).toHaveBeenCalledWith("/p/src/a.ts\n/p/docs/b.md");
  });

  it("copies nothing when the selection has no files", () => {
    copyChangePaths([], "name");
    expect(writeText).not.toHaveBeenCalled();
  });
});
