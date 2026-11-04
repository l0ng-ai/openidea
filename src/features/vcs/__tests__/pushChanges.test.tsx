import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Commit } from "@/bindings";

const { files, combined } = vi.hoisted(() => ({ files: vi.fn(), combined: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsCommitFiles: files, vcsCommitsChanges: combined } };
});

import { PushChanges } from "../PushChanges";

const commit = (id: string, parent: string): Commit =>
  ({ id, shortId: id.slice(0, 7), parents: [parent], summary: id, author: "me", timeMs: 0 }) as unknown as Commit;
const newer = commit("bbbbbbbbbb", "aaaaaaaaaa");
const older = commit("aaaaaaaaaa", "9999999999");

describe("Push dialog changes", () => {
  it("lists the combined changes of all outgoing commits, oldest first to the backend", async () => {
    combined.mockResolvedValue({
      status: "ok",
      data: [
        { path: "src/app/Main.java", oldPath: null, kind: "modified", before: "9999999999", after: "bbbbbbbbbb" },
        { path: "README.md", oldPath: null, kind: "added", before: null, after: "bbbbbbbbbb" },
      ],
    });
    render(<PushChanges repo="/r" commits={[newer, older]} />);
    expect(await screen.findByText("Main.java")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText(/2 files in 2 commits/)).toBeTruthy();
    expect(combined).toHaveBeenCalledWith("/r", ["aaaaaaaaaa", "bbbbbbbbbb"]);
  });

  it("shows one commit's files and offers going back to all commits", async () => {
    files.mockResolvedValue({ status: "ok", data: [{ path: "a.txt", oldPath: null, kind: "deleted" }] });
    const showAll = vi.fn();
    render(<PushChanges repo="/r" commits={[older]} onShowAll={showAll} />);
    expect(await screen.findByText("a.txt")).toBeTruthy();
    expect(files).toHaveBeenCalledWith("/r", "aaaaaaaaaa");
    fireEvent.click(screen.getByRole("button", { name: "Show All Commits" }));
    expect(showAll).toHaveBeenCalled();
  });
});
