import { describe, expect, it } from "vitest";
import type { MenuItem } from "@/ui";
import { commonBranchMenu } from "../branchMenu";
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
