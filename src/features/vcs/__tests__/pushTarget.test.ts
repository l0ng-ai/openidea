import { describe, expect, it } from "vitest";
import { pushOperation, type PushChoice } from "../pushTarget";

const tracked: PushChoice = {
  head: "feat-x",
  tracked: "origin/feat-x",
  remote: "origin",
  target: "feat-x",
  forceWithLease: false,
  setUpstream: false,
  tags: null,
  noVerify: false,
};

describe("the operation a push dialog sends", () => {
  it("is the plain push of the tracked branch while remote and target are unchanged", () => {
    expect(pushOperation({ ...tracked, tags: "all" })).toEqual({
      op: "push",
      force_with_lease: false,
      set_upstream: false,
      tags: "all",
      no_verify: false,
    });
    // No remote picked yet, or the default name with stray spaces, or a cleared field.
    expect(pushOperation({ ...tracked, remote: null }).op).toBe("push");
    expect(pushOperation({ ...tracked, target: "  feat-x " }).op).toBe("push");
    expect(pushOperation({ ...tracked, target: "" }).op).toBe("push");
  });

  it("pushes to another branch of the tracked remote when the target changes", () => {
    expect(pushOperation({ ...tracked, target: " release-2.1 " })).toEqual({
      op: "pushBranch",
      branch: "feat-x",
      revision: null,
      force_with_lease: false,
      target: "release-2.1",
      remote: null,
      set_upstream: false,
      no_verify: false,
    });
  });

  it("pushes the tracked branch name to another remote when the remote changes", () => {
    expect(pushOperation({ ...tracked, remote: "fork" })).toMatchObject({
      op: "pushBranch",
      branch: "feat-x",
      target: null,
      remote: "fork",
    });
  });

  it("sets the upstream of a branch without one on the plain push", () => {
    expect(pushOperation({ ...tracked, tracked: null, remote: null })).toMatchObject({
      op: "push",
      set_upstream: true,
    });
    expect(pushOperation({ ...tracked, tracked: null, remote: null, target: "feat-y" })).toMatchObject({
      op: "pushBranch",
      target: "feat-y",
      remote: null,
    });
  });

  it("keeps force-with-lease and the hook choice on both kinds", () => {
    const force = { ...tracked, forceWithLease: true, noVerify: true };
    expect(pushOperation(force)).toMatchObject({ op: "push", force_with_lease: true, no_verify: true });
    expect(pushOperation({ ...force, target: "release-2.1" })).toMatchObject({
      op: "pushBranch",
      force_with_lease: true,
      no_verify: true,
    });
  });

  it("drops tags once the target changes: pushing a branch carries none", () => {
    const op = pushOperation({ ...tracked, tags: "all", target: "release-2.1" });
    expect(op.op).toBe("pushBranch");
    expect(op).not.toHaveProperty("tags");
  });

  it("pushes another branch or a revision explicitly, without moving the upstream of a partial push", () => {
    expect(pushOperation({ ...tracked, explicit: true })).toMatchObject({ op: "pushBranch", target: null });
    expect(pushOperation({ ...tracked, explicit: true, revision: "abc123", setUpstream: true })).toMatchObject({
      op: "pushBranch",
      revision: "abc123",
      set_upstream: false,
    });
  });
});
