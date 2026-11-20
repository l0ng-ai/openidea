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
    expect(labels(commonBranchMenu(common("feature"), ["/a", "/b"]))).toContain("Rename…");
    expect(labels(commonBranchMenu(common("main", { current: true }), ["/a", "/b"]))).toContain("Rename…");
    expect(labels(commonBranchMenu(common("origin/main", { remote: true }), ["/a", "/b"]))).not.toContain("Rename…");
  });
});
