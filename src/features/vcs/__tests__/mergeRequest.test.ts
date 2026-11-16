import { expect, it } from "vitest";
import type { Branch } from "@/bindings";
import { localBranchFor, mergeRequestUrl, parseTarget, pushesTarget, targetOptions } from "../mergeRequest";

const b = (name: string, remote = false, current = false): Branch =>
  ({ name, remote, current, upstream: null }) as unknown as Branch;

it("keeps the checked-out branch when the select is left empty", () => {
  expect(parseTarget("", [])).toEqual({ kind: "current" });
  expect(localBranchFor(parseTarget("", []))).toBeNull();
  expect(pushesTarget(parseTarget("", []))).toBe(false);
});

it("tells a local branch from a remote one", () => {
  const branches = [b("develop"), b("origin/develop", true)];
  expect(parseTarget("develop", branches)).toEqual({ kind: "local", name: "develop" });
  expect(parseTarget("origin/develop", branches)).toEqual({
    kind: "remote",
    name: "origin/develop",
    remote: "origin",
    branch: "develop",
  });
  // A name missing from the list falls back to the `remote/` prefix.
  expect(parseTarget("upstream/main", [])).toEqual({
    kind: "remote",
    name: "upstream/main",
    remote: "upstream",
    branch: "main",
  });
});

it("merges a remote target on its local namesake and pushes it back", () => {
  const target = parseTarget("origin/develop", []);
  expect(localBranchFor(target)).toBe("develop");
  expect(pushesTarget(target)).toBe(true);
});

it("offers the current branch, then local and remote branches, without the source", () => {
  const options = targetOptions([b("develop", false, true), b("main"), b("feature/x"), b("origin/develop", true)], "develop", "feature/x");
  const values = options.filter((o) => !o.section).map((o) => o.value);
  expect(values).toEqual(["", "main", "origin/develop"]);
  expect(options.filter((o) => o.section).map((o) => o.label)).toEqual(["Local branches", "Remote branches"]);
});

it("opens a merge request page for the hosts it knows", () => {
  expect(mergeRequestUrl("git@github.com:me/repo.git", "feature/x", "develop")).toBe(
    "https://github.com/me/repo/compare/develop...feature%2Fx?expand=1",
  );
  expect(mergeRequestUrl("https://gitlab.com/g/repo.git", "feature/x", "develop")).toBe(
    "https://gitlab.com/g/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx&merge_request%5Btarget_branch%5D=develop",
  );
  expect(mergeRequestUrl("git@bitbucket.org:me/repo.git", "feature/x", "develop")).toBe(
    "https://bitbucket.org/me/repo/pull-requests/new?source=feature%2Fx&dest=develop&t=1",
  );
  expect(mergeRequestUrl(null, "feature/x", "develop")).toBeNull();
});
