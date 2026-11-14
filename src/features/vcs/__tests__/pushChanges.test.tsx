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
  ({
    id,
    shortId: id.slice(0, 7),
    parents: [parent],
    summary: id,
    message: id,
    author: "me",
    email: "me@example.com",
    timeMs: 0,
  }) as unknown as Commit;
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

  it("shows the selected commit's message and author, and lists files flat on request", async () => {
    localStorage.clear();
    files.mockResolvedValue({
      status: "ok",
      data: [{ path: "src/orders/service.py", oldPath: null, kind: "added" }],
    });
    const one = { ...older, message: "Add order service\n\nIntroduces the service.\n", timeMs: 1_700_000_000_000 };
    render(<PushChanges repo="/r" commits={[one]} />);
    const details = screen.getByRole("region", { name: "Commit details" });
    expect(details.textContent).toContain("Add order service\n\nIntroduces the service.");
    expect(details.textContent).toContain("aaaaaaa me <me@example.com> on ");
    expect(await screen.findByText("src/orders")).toBeTruthy();
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    const grouping = screen.getByRole("button", { name: "Group by Directory" });
    expect(grouping.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(grouping);
    expect(grouping.getAttribute("aria-pressed")).toBe("false");
    // Flat: one row, the file, with its directory beside the name.
    const rows = screen.getAllByRole("treeitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("service.py");
    expect(rows[0]!.textContent).toContain("src/orders");
    expect(localStorage.getItem("openidea.vcs.push.groupByDirectory")).toBe("false");
  });

  it("shows no commit details for several commits", async () => {
    combined.mockResolvedValue({ status: "ok", data: [] });
    render(<PushChanges repo="/r" commits={[newer, older]} />);
    expect(await screen.findByText(/0 files in 2 commits/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Commit details" })).toBeNull();
  });
});
