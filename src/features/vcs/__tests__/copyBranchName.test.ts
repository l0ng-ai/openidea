import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, getAction, isActionEnabled, registerAction, registerActions } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { IDEA_ACTIONS } from "@/platform/ideaActions";
import { provideNotificationService } from "@/workbench/contributions";
import { copyBranchNameActions } from "../copyBranchName";
import { useVcs } from "../store";

const writeText = vi.fn(async (_text: string) => undefined);
const hint = vi.fn();
const disposers: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: navigator.userAgent });
  provideNotificationService({ notify: vi.fn() });
  setContext("vcsAvailable", true);
  useVcs.setState({
    roots: ["/w/api", "/w/web"],
    repo: "/w/api",
    heads: {
      "/w/api": { head: "feature/login", headCommit: "a1" },
      "/w/web": { head: "main", headCommit: "b2" },
    },
  });
  disposers.push(
    registerActions(copyBranchNameActions),
    registerAction({ id: "editor.showHint", title: "Hint", run: ({ arg }) => hint(arg) }),
  );
});

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  useVcs.setState({ roots: [], repo: null, heads: {} });
  clearContext("vcsAvailable");
  vi.unstubAllGlobals();
});

describe("Copy Branch Name", () => {
  it("copies the selected repository's current branch", async () => {
    await executeAction("vcs.copyBranchName");
    await vi.waitFor(() => expect(hint).toHaveBeenCalledWith({ text: "Copied feature/login" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("feature/login");
  });

  it("copies the branch of the repository the action was invoked for", async () => {
    await executeAction("vcs.copyBranchName", { repo: "/w/web" });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("main"));
  });

  it("is disabled on a detached HEAD", () => {
    useVcs.setState({ heads: { "/w/api": { head: null, headCommit: "a1" } } });
    expect(isActionEnabled(getAction("vcs.copyBranchName")!)).toBe(false);
    useVcs.setState({ heads: { "/w/api": { head: "dev", headCommit: "a1" } } });
    expect(isActionEnabled(getAction("vcs.copyBranchName")!)).toBe(true);
  });

  it("is IntelliJ's Vcs.CopyCurrentBranchName", () => {
    expect(IDEA_ACTIONS["Vcs.CopyCurrentBranchName"]).toBe("vcs.copyBranchName");
  });
});
