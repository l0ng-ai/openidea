import { describe, expect, it } from "vitest";
import type { Branch } from "@/bindings";
import type { MenuItem } from "@/ui";
import { commonBranchMenu, mergedBranchMenu } from "../branchMenu";
import type { CommonBranch } from "../repoBranches";

const common = (name: string, opts: Partial<CommonBranch> = {}): CommonBranch => ({
  name,
  remote: false,
  current: false,
  favorite: false,
  upstream: false,
  ...opts,
});
const labels = (items: MenuItem[]) => items.flatMap((i) => ("label" in i && i.label ? [i.label] : []));

describe("commonBranchMenu", () => {
  it("offers Rename for local branches, current or not, and not for remote ones", () => {
    expect(labels(commonBranchMenu(common("feature"), ["/a", "/b"], "main"))).toContain("Rename…");
    expect(labels(commonBranchMenu(common("main", { current: true }), ["/a", "/b"], "main"))).toContain("Rename…");
    expect(labels(commonBranchMenu(common("origin/main", { remote: true }), ["/a", "/b"], "main"))).not.toContain(
      "Rename…",
    );
  });

  it("offers Checkout and Rebase only while the repositories share a current branch", () => {
    const roots = ["/a", "/b"];
    const rebase = (items: MenuItem[]) => labels(items).filter((l) => l.startsWith("Checkout and Rebase"));
    expect(rebase(commonBranchMenu(common("feature"), roots, "main"))).toEqual(["Checkout and Rebase onto 'main'"]);
    expect(rebase(commonBranchMenu(common("feature"), roots, null))).toEqual([]);
    expect(rebase(commonBranchMenu(common("main", { current: true }), roots, "main"))).toEqual([]);
  });
});

describe("mergedBranchMenu", () => {
  const branch = (name: string, opts: Partial<Branch> = {}): Branch => ({
    name,
    remote: false,
    current: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    lastCommitMs: 0,
    commit: "",
    ...opts,
  });
  const roots = ["/a", "/b"];
  const dev = branch("dev");
  const own = roots.map((repo) => ({ repo, branch: dev }));

  it("acts in every repository that has the branch, with favorites and history", () => {
    const items = labels(mergedBranchMenu(dev, common("dev"), roots, "main", own));
    expect(items).toEqual(
      expect.arrayContaining(["Merge 'dev' into Current", "Add to Favorites", "Show History", "Update"]),
    );
    expect(items.filter((l) => l === "Delete")).toHaveLength(1);
  });

  it("updates and deletes the whole selection when several branches are selected", () => {
    const selected = [...own, { repo: "/a", branch: branch("solo") }];
    const items = labels(mergedBranchMenu(dev, common("dev"), roots, "main", selected));
    expect(items).toContain("Update Selected");
    expect(items).not.toContain("Update");
    expect(items.filter((l) => l === "Delete")).toHaveLength(1);
    expect(items).toContain("Merge 'dev' into Current");
  });

  it("deletes a remote branch in each repository", () => {
    const origin = branch("origin/dev", { remote: true });
    const items = labels(
      mergedBranchMenu(
        origin,
        common("origin/dev", { remote: true }),
        roots,
        "main",
        roots.map((repo) => ({ repo, branch: origin })),
      ),
    );
    expect(items).toContain("Delete");
  });
});
