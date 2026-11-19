import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vcsLog = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
      vcsConfigGet: async () => ({ status: "ok", data: null }),
      fsReadText: async () => ({ status: "error", error: { kind: "notFound", message: "" } }),
    },
  };
});

import {
  flushDraft,
  installPreparedMessage,
  keepMessageAfterCommit,
  savedDraft,
  setAmend,
  useCommit,
} from "../commitStore";
import { useVcs } from "../store";

describe("commit message draft (#4423)", () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [{ message: "last commit\n" }] });
    useVcs.setState({ root: "/a", repo: null, roots: ["/a"], branch: null });
    useCommit.setState({ message: "", amend: false });
    dispose = installPreparedMessage();
  });
  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  const type = (message: string) => useCommit.setState({ message });

  it("is saved per project after a pause, not on every keystroke", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    type("f");
    type("fi");
    type("fix: draft");
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(savedDraft("/a")).toBe("fix: draft");
    setItem.mockRestore();
  });

  it("is restored when the project opens again (restart)", () => {
    type("wip");
    window.dispatchEvent(new Event("pagehide"));
    expect(savedDraft("/a")).toBe("wip");
    dispose();
    useCommit.setState({ message: "" });
    dispose = installPreparedMessage();
    expect(useCommit.getState().message).toBe("wip");
  });

  it("stays with its project when the window switches to another one", () => {
    type("for a");
    useVcs.setState({ root: "/b", roots: ["/b"] });
    expect(savedDraft("/a")).toBe("for a");
    expect(useCommit.getState().message).toBe("");
    type("for b");
    useVcs.setState({ root: "/a", roots: ["/a"] });
    expect(useCommit.getState().message).toBe("for a");
    expect(savedDraft("/b")).toBe("for b");
  });

  it("is cleared by a successful commit, whether or not the message stays in the field", () => {
    type("feat: x");
    flushDraft();
    keepMessageAfterCommit("feat: x", false);
    flushDraft();
    expect(savedDraft("/a")).toBe("");
    type("feat: y");
    flushDraft();
    keepMessageAfterCommit("feat: y", true);
    flushDraft();
    expect(savedDraft("/a")).toBe("");
  });

  it("keeps the typed draft, not the amended commit's message, while Amend is on", async () => {
    type("my draft");
    flushDraft();
    await setAmend(true);
    expect(useCommit.getState().message).toBe("last commit");
    flushDraft();
    expect(savedDraft("/a")).toBe("my draft");
    await setAmend(false);
    expect(useCommit.getState().message).toBe("my draft");
    flushDraft();
    expect(savedDraft("/a")).toBe("my draft");
  });
});
