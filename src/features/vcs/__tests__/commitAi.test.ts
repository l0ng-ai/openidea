import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus, LineHunk } from "@/bindings";

const backend = vi.hoisted(() => ({
  vcsFileAt: vi.fn(),
  fsReadText: vi.fn(),
  vcsDiffHunks: vi.fn(),
  vcsCommitAiSettings: vi.fn(),
  vcsGenerateCommitMessage: vi.fn(),
  cancelRequest: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    ...backend,
    vcsCommitAiReadText: (path: string, revision: string | null) =>
      revision ? backend.vcsFileAt(path, revision) : backend.fsReadText(path),
  },
}));
vi.mock("../dialogs", () => ({ confirmDialog: backend.confirm }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: backend.notify }),
}));

import {
  cancelCommitMessage,
  generateCommitMessage,
  installCommitAi,
  selectedCommitDiff,
  useCommitAi,
} from "../commitAi";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";
import { hunkKeys } from "../hunks";

const file = (name: string, extra: Partial<FileStatus> = {}): FileStatus => ({
  path: `/repo/${name}`,
  relPath: name,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
  ...extra,
});
const hunks: LineHunk[] = [
  { start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "old\n", kind: "modified" },
  { start: 2, lines: 1, oldStart: 2, oldLines: 1, oldText: "private-old\n", kind: "modified" },
];
const ok = <T>(data: T) => ({ status: "ok", data });

beforeEach(() => {
  vi.resetAllMocks();
  backend.vcsFileAt.mockResolvedValue(ok("old\nkeep\nprivate-old\n"));
  backend.fsReadText.mockResolvedValue(ok("new\nkeep\nprivate-new\n"));
  backend.vcsDiffHunks.mockResolvedValue(hunks);
  backend.vcsCommitAiSettings.mockResolvedValue(
    ok({ config: { baseUrl: "https://example.com/v1", model: "test" }, hasApiKey: false }),
  );
  backend.vcsGenerateCommitMessage.mockResolvedValue(ok("修改摘要\n\n- 修改详情"));
  backend.cancelRequest.mockResolvedValue(undefined);
  backend.confirm.mockResolvedValue(true);
  useCommit.setState({ message: "", checks: new Map(), excludedHunks: new Map() });
  useCommitAi.setState({ generation: null, error: null });
  useVcs.setState({ root: "/repo", roots: ["/repo"], status: [file("a.ts")] });
});

describe("selected commit evidence", () => {
  it("omits unchecked files and excluded blocks entirely", async () => {
    const keys = hunkKeys("new\nkeep\nprivate-new\n", hunks);
    const diff = await selectedCommitDiff(
      [file("a.ts"), file("secret.ts")],
      new Map([
        ["/repo/a.ts", "hunks"],
        ["/repo/secret.ts", "none"],
      ]),
      new Map([["/repo/a.ts", new Set([keys[1]!])]]),
      () => false,
    );
    expect(diff).toContain('"added":"new\\n"');
    expect(diff).not.toContain("private-");
    expect(diff).not.toContain("secret.ts");
    expect(backend.fsReadText).toHaveBeenCalledTimes(1);
  });

  it("reads the index for staged-only files, including a rename source", async () => {
    await selectedCommitDiff(
      [file("new.ts", { staged: "renamed", renamedFrom: "old.ts" })],
      new Map([["/repo/new.ts", "staged"]]),
      new Map(),
      () => false,
    );
    expect(backend.vcsFileAt.mock.calls).toEqual([
      ["/repo/old.ts", "HEAD"],
      ["/repo/new.ts", ":0"],
    ]);
    expect(backend.fsReadText).not.toHaveBeenCalled();
  });

  it("does not read deleted working files, and describes empty additions", async () => {
    await selectedCommitDiff([file("gone.ts", { unstaged: "deleted" })], new Map(), new Map(), () => false);
    expect(backend.fsReadText).not.toHaveBeenCalled();
    backend.vcsFileAt.mockResolvedValue(ok(""));
    backend.fsReadText.mockResolvedValue(ok(""));
    backend.vcsDiffHunks.mockResolvedValue([]);
    const diff = await selectedCommitDiff(
      [file("empty.txt", { unstaged: "untracked" })],
      new Map([["/repo/empty.txt", "all"]]),
      new Map(),
      () => false,
    );
    expect(diff).toContain('"kind":"untracked"');
  });

  it("rejects excessive evidence and never sends binary content", async () => {
    backend.fsReadText.mockResolvedValue(ok("\0private binary data"));
    const diff = await selectedCommitDiff([file("a.bin")], new Map(), new Map(), () => false);
    expect(diff).toContain('"binary":true');
    expect(diff).not.toContain("private binary data");
    backend.fsReadText.mockResolvedValue(ok("a".repeat(1_000_001)));
    await expect(selectedCommitDiff([file("a.ts")], new Map(), new Map(), () => false)).rejects.toThrow("too large");
  });
});

describe("generation lifecycle", () => {
  it("fills a draft without committing or staging", async () => {
    await generateCommitMessage();
    expect(useCommit.getState().message).toBe("修改摘要\n\n- 修改详情");
    expect(backend.confirm).not.toHaveBeenCalled();
    expect(useCommitAi.getState()).toMatchObject({ generation: null, error: null });
  });

  it("does not call the service when replacing an existing draft is declined", async () => {
    useCommit.setState({ message: "my draft" });
    backend.confirm.mockResolvedValue(false);
    await generateCommitMessage();
    expect(useCommit.getState().message).toBe("my draft");
    expect(backend.vcsGenerateCommitMessage).not.toHaveBeenCalled();
  });

  it("keeps the draft on service failure or missing settings", async () => {
    useCommit.setState({ message: "my draft" });
    backend.vcsGenerateCommitMessage.mockRejectedValue(new Error("HTTP 401"));
    await generateCommitMessage();
    expect(useCommit.getState().message).toBe("my draft");
    expect(useCommitAi.getState().error).toBe("HTTP 401");
    backend.vcsCommitAiSettings.mockResolvedValue(ok({ config: { baseUrl: "", model: "" } }));
    backend.vcsGenerateCommitMessage.mockClear();
    await generateCommitMessage();
    expect(backend.vcsGenerateCommitMessage).not.toHaveBeenCalled();
    expect(useCommitAi.getState().error).toContain("Configure AI");
  });

  it.each(["cancel", "edit", "project", "selection"])(
    "protects the draft after %s while a response is pending",
    async (operation) => {
      let respond!: (data: ReturnType<typeof ok<string>>) => void;
      backend.vcsGenerateCommitMessage.mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      const stop = installCommitAi();
      const pending = generateCommitMessage();
      await vi.waitFor(() => expect(backend.vcsGenerateCommitMessage).toHaveBeenCalled());
      if (operation === "cancel") cancelCommitMessage();
      else if (operation === "project") useVcs.setState({ root: "/other" });
      else if (operation === "selection") useCommit.setState({ checks: new Map([["/repo/a.ts", "none"]]) });
      else useCommit.setState({ message: "typed while waiting" });
      respond(ok("stale AI result"));
      await pending;
      expect(useCommit.getState().message).toBe(operation === "edit" ? "typed while waiting" : "");
      if (operation === "cancel" || operation === "project") expect(backend.cancelRequest).toHaveBeenCalled();
      stop();
    },
  );
});
