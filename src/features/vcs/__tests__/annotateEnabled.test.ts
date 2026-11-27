import { afterEach, describe, expect, it } from "vitest";
import { getAction, isActionEnabled } from "@/platform/actions";
import { registerVcsActions } from "../actions";
import { useVcs } from "../store";

afterEach(() => useVcs.setState({ byPath: new Map() }));

const status = (path: string, staged: string | null, unstaged: string | null) =>
  [path, { path, relPath: path.slice(6), staged, unstaged, renamedFrom: null }] as const;

describe("Annotate with Git Blame", () => {
  it("is off for a file Git has no commit of, as in IDEA", () => {
    const unregister = registerVcsActions();
    try {
      useVcs.setState({
        byPath: new Map([
          status("/repo/new.py", null, "untracked"),
          status("/repo/ignored_test.py", null, "ignored"),
          status("/repo/added.py", "added", null),
          status("/repo/edited.py", null, "modified"),
        ]) as never,
      });
      const action = getAction("vcs.annotate")!;
      const enabled = (path: string) => isActionEnabled(action, { vcsAvailable: true }, path);
      expect(enabled("/repo/new.py")).toBe(false);
      expect(enabled("/repo/ignored_test.py")).toBe(false);
      expect(enabled("/repo/added.py")).toBe(false);
      expect(enabled("/repo/edited.py")).toBe(true);
      expect(enabled("/repo/clean.py")).toBe(true);
    } finally {
      unregister();
    }
  });
});
