/** Which push a Push dialog sends for one repository, from the remote and target picked in it. */
import type { PushTags, RemoteOp } from "@/bindings";

export type PushOp = Extract<RemoteOp, { op: "push" | "pushBranch" }>;

export interface PushChoice {
  /** Local branch being pushed. */
  head: string;
  /** Its upstream as `remote/branch`, or null. */
  tracked: string | null;
  /** Remote picked in the dialog; null keeps the tracked one. */
  remote: string | null;
  /** Target branch field as typed; empty keeps the default. */
  target: string;
  /** Another branch than the checked-out one: always pushed by name. */
  explicit?: boolean;
  /** Push only up to this commit. */
  revision?: string | null;
  forceWithLease: boolean;
  setUpstream: boolean;
  /** Dropped once the push is retargeted: `pushBranch` carries no tags. */
  tags: PushTags | null;
  noVerify: boolean;
}

/** `remote/branch` split at the first slash. */
export function splitTracked(tracked: string): { remote: string; branch: string } {
  const slash = tracked.indexOf("/");
  return { remote: tracked.slice(0, slash), branch: tracked.slice(slash + 1) };
}

/**
 * The plain push while remote and target are those of the upstream, which keeps tags
 * and the update-and-retry of a rejected push; otherwise `git push <remote> <src>:<dst>`
 * naming only what differs from the upstream.
 */
export function pushOperation(c: PushChoice): PushOp {
  const upstream = c.tracked ? splitTracked(c.tracked) : null;
  const defaultTarget = upstream?.branch ?? c.head;
  const edited = c.target.trim();
  const retarget = !!edited && edited !== defaultTarget;
  const remoteChanged = !!c.remote && c.remote !== (upstream?.remote ?? null);
  const revision = c.revision ?? null;
  if (c.explicit || revision || retarget || remoteChanged)
    return {
      op: "pushBranch",
      branch: c.head,
      revision,
      force_with_lease: c.forceWithLease,
      target: retarget ? edited : null,
      remote: remoteChanged ? c.remote : null,
      set_upstream: c.setUpstream && !revision,
      no_verify: c.noVerify,
    };
  return {
    op: "push",
    force_with_lease: c.forceWithLease,
    set_upstream: c.setUpstream || !c.tracked,
    tags: c.tags,
    no_verify: c.noVerify,
  };
}
