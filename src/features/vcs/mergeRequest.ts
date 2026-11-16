/**
 * Merge dialog: the branch a merge lands on (a local branch, or a remote branch
 * that is checked out first), and the page that opens a merge request for
 * "source → target" on the remote's web UI.
 */
import type { Branch } from "@/bindings";
import type { SelectOption } from "@/ui";
import { shortRemoteName, sortLocal, sortRemote } from "./branches";
import { remoteHosting, remoteWebUrl } from "./model";

/** Where the result of a merge goes: the checked-out branch, a local branch, or a remote branch. */
export type MergeTarget =
  | { kind: "current" }
  | { kind: "local"; name: string }
  | { kind: "remote"; name: string; remote: string; branch: string };

/** Value of the "Merge into" select: `""` keeps the checked-out branch. */
export function targetValue(target: MergeTarget): string {
  return target.kind === "current" ? "" : target.name;
}

/**
 * Target named by a "Merge into" select value, read against the repository's branches
 * (a value unknown to the list is taken as remote when it carries a `<remote>/` prefix).
 */
export function parseTarget(value: string | null | undefined, branches: readonly Branch[]): MergeTarget {
  const name = (value ?? "").trim();
  if (!name) return { kind: "current" };
  const known = branches.find((b) => b.name === name);
  const slash = name.indexOf("/");
  if (known ? known.remote : slash > 0) {
    const cut = slash < 0 ? name.length : slash;
    return { kind: "remote", name, remote: name.slice(0, cut), branch: name.slice(cut + 1) };
  }
  return { kind: "local", name };
}

/** Local branch the merge is done on: a remote target `origin/develop` merges on `develop`. */
export function localBranchFor(target: MergeTarget): string | null {
  switch (target.kind) {
    case "current":
      return null;
    case "local":
      return target.name;
    case "remote":
      return shortRemoteName(target.name);
  }
}

/** `true` when the merged target has to be pushed back to the remote branch it came from. */
export function pushesTarget(target: MergeTarget): boolean {
  return target.kind === "remote";
}

/** Options of the "Merge into" select: the checked-out branch first, then local, then remote branches. */
export function targetOptions(
  branches: readonly Branch[],
  head: string | null,
  source: string | null,
): SelectOption[] {
  const current: SelectOption = {
    value: "",
    label: head ? `Current branch (${head})` : "Current branch",
    icon: "branch",
  };
  const local = sortLocal(branches)
    .filter((b) => !b.current && b.name !== head && b.name !== source)
    .map((b) => ({ value: b.name, label: b.name, icon: "branch" }));
  const remote = sortRemote(branches)
    .filter((b) => b.name !== source)
    .map((b) => ({ value: b.name, label: b.name, detail: shortRemoteName(b.name), icon: "branch" }));
  return [
    current,
    ...(local.length ? [{ value: "__local__", label: "Local branches", section: true }, ...local] : []),
    ...(remote.length ? [{ value: "__remote__", label: "Remote branches", section: true }, ...remote] : []),
  ];
}

/**
 * Page that opens a merge request with `source` into `target` on the remote's web UI,
 * or null when the remote is not a hosting service this knows (or has no URL).
 */
export function mergeRequestUrl(remoteUrl: string | null, source: string, target: string): string | null {
  const base = remoteWebUrl(remoteUrl ?? "");
  const hosting = remoteUrl ? remoteHosting(remoteUrl) : null;
  if (!base || !hosting) return null;
  const src = encodeURIComponent(source);
  const dst = encodeURIComponent(target);
  switch (hosting.kind) {
    case "github":
      // GitHub and Gitee: the compare page opens the pull request form with `expand=1`.
      return `${base}/compare/${dst}...${src}?expand=1`;
    case "gitlab":
      return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${src}&merge_request%5Btarget_branch%5D=${dst}`;
    case "bitbucket":
      return `${base}/pull-requests/new?source=${src}&dest=${dst}&t=1`;
  }
}
