import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import type { MenuItem } from "@/ui";
import type { ChangeNode } from "../changes";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

import { nodeMenu } from "../CommitView";

const file = (rel: string, unstaged: FileStatus["unstaged"] = "modified"): ChangeNode => {
  const f: FileStatus = {
    path: `/p/${rel}`,
    relPath: rel,
    staged: null,
    unstaged,
    renamedFrom: null,
  };
  return {
    key: f.path,
    type: "file",
    label: rel,
    group: "unversioned",
    files: [f],
    path: f.path,
  };
};

const item = (menu: MenuItem[], label: string) =>
  menu.find((m) => m.kind !== "separator" && "label" in m && m.label === label);

describe("Add to .gitignore in the changes view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers both destinations in a submenu, as the project view's Git menu does", () => {
    const menu = nodeMenu([file("new.txt", "untracked")], ["/p"]);
    expect(item(menu, "Add to .gitignore")).toMatchObject({
      submenu: [
        {
          kind: "action",
          action: "vcs.ignoreShared",
          arg: ["/p/new.txt"],
          label: ".gitignore",
        },
        {
          kind: "action",
          action: "vcs.ignoreLocal",
          arg: ["/p/new.txt"],
          label: ".git/info/exclude",
        },
      ],
    });
  });

  it("targets only the unversioned files of a mixed selection", () => {
    const menu = nodeMenu([file("a.ts", "modified"), file("new.txt", "untracked")], ["/p"]);
    const parent = item(menu, "Add to .gitignore");
    expect(parent).toMatchObject({
      submenu: [
        { action: "vcs.ignoreShared", arg: ["/p/new.txt"] },
        { action: "vcs.ignoreLocal", arg: ["/p/new.txt"] },
      ],
    });
  });

  it("offers nothing when no unversioned file is selected", () => {
    const menu = nodeMenu([file("a.ts", "modified")], ["/p"]);
    expect(item(menu, "Add to .gitignore")).toBeUndefined();
  });
});
