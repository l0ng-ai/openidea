import { afterEach, describe, expect, it } from "vitest";
import { installCommitMessages, useCommit } from "../commitStore";
import { installGitLog, useGitLog } from "../logStore";
import { logConsole, useVcsConsole } from "../ops";
import { useVcs } from "../store";

describe("switching the window to another repository", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => disposers.splice(0).forEach((d) => d()));

  it("drops the commit message, Amend and the log of the previous one", () => {
    useVcs.setState({ root: "/a" });
    disposers.push(installCommitMessages(), installGitLog());
    useCommit.setState({ message: "wip", amend: true, selection: ["/a/x"] });
    useGitLog.setState({ commits: [{ id: "c1" } as never], selected: "c1", selection: ["c1"] });
    useGitLog.setState((s) => ({ filters: { ...s.filters, authors: ["me"] } }));
    logConsole("cmd", "git status");

    useVcs.setState({ root: "/b" });

    expect(useCommit.getState()).toMatchObject({ message: "", amend: false, selection: [] });
    expect(useGitLog.getState()).toMatchObject({ commits: [], selected: null, selection: [] });
    expect(useGitLog.getState().filters.authors).toEqual([]);
    expect(useVcsConsole.getState().lines).toEqual([]);
  });
});
