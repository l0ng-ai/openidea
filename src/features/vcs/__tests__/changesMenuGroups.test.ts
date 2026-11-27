import { afterEach, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import type { MenuItem } from "@/ui";
import { registerMenuGroup } from "@/workbench/contributions";
import type { ChangeNode } from "../changes";

const { nodeMenu } = await import("../CommitView");

const file = (rel: string, unstaged: FileStatus["unstaged"], staged: FileStatus["staged"] = null): ChangeNode => {
  const f: FileStatus = { path: `/p/${rel}`, relPath: rel, staged, unstaged, renamedFrom: null };
  return { key: f.path, type: "file", label: rel, group: "changes", files: [f], path: f.path };
};

let dispose: () => void = () => {};
afterEach(() => dispose());

it("adds other features' groups for the changed files still on disk", () => {
  const items = vi.fn((_menu: string, { paths }: { paths: string[] }): MenuItem[] =>
    paths.length ? [{ id: "deployment", label: "Deployment", submenu: [] }] : [],
  );
  dispose = registerMenuGroup({ id: "deployment", menus: ["changes"], items });
  const labels = (menu: MenuItem[]) => menu.flatMap((i) => (i.kind !== "separator" && "label" in i ? [i.label] : []));

  const menu = nodeMenu([file("a.txt", "modified"), file("gone.txt", "deleted"), file("new.txt", "untracked")], ["/p"]);
  expect(items).toHaveBeenLastCalledWith("changes", { paths: ["/p/a.txt", "/p/new.txt"] });
  expect(labels(menu)).toContain("Deployment");

  expect(labels(nodeMenu([file("gone.txt", "deleted")], ["/p"]))).not.toContain("Deployment");
});
