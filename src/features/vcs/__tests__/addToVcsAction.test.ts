import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

const stage = vi.hoisted(() => vi.fn(async () => ({ status: "ok", data: null })));
const ignore = vi.hoisted(() => vi.fn(async () => ({ status: "ok", data: [] })));
const notify = vi.hoisted(() => vi.fn());
const project = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStage: stage,
      vcsAddToIgnore: ignore,
      vcsStatus: async () => ({ status: "ok", data: [] }),
      vcsBranchInfo: async () => ({ status: "ok", data: null }),
      vcsRoots: async () => ({ status: "ok", data: [{ root: "/repo", operation: null }] }),
    },
  };
});
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  projectViewSelection: () => project.paths,
  notifications: () => ({ notify }),
}));
vi.mock("../comparePaths", () => ({ showDirectoryWorkingDiff: async () => false }));
vi.mock("../diffDialog", () => ({ openDiffDialog: vi.fn() }));
vi.mock("../DiffWindow", () => ({ showDiffWindow: vi.fn() }));

import { getAction } from "@/platform/actions";
import { registerVcsActions } from "../actions";
import { useVcs } from "../store";

const fs = (relPath: string, unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/repo/${relPath}`,
  relPath,
  staged: null,
  unstaged,
  renamedFrom: null,
});

let unregister: () => void;

beforeEach(() => {
  stage.mockClear();
  ignore.mockClear();
  notify.mockClear();
  project.paths = [];
  const files = [fs("dir/new.ts", "untracked"), fs("dir/sub/n2.ts", "untracked"), fs("dir/tracked.ts", "modified")];
  useVcs.setState({
    root: "/repo",
    roots: ["/repo"],
    status: files,
    byPath: new Map(files.map((f) => [f.path, f])),
    statusLoaded: true,
  });
  unregister = registerVcsActions();
});

afterEach(() => unregister());

const addToVcs = () => getAction("vcs.addToVcs")!;

describe("Add to VCS", () => {
  it("adds the unversioned files below the Project view's selected directory", async () => {
    project.paths = ["/repo/dir"];
    await addToVcs().run({ arg: undefined, ctx: { vcsAvailable: true, projectViewFocus: true } });
    expect(stage).toHaveBeenCalledWith(["/repo/dir/new.ts", "/repo/dir/sub/n2.ts"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves the Project view's selection alone while another view has focus", async () => {
    project.paths = ["/repo/dir"];
    await addToVcs().run({ arg: undefined, ctx: { vcsAvailable: true } });
    expect(stage).not.toHaveBeenCalled();
  });

  it("only adds the unversioned files under an explicit selection", async () => {
    await addToVcs().run({ arg: ["/repo/dir/tracked.ts"], ctx: { vcsAvailable: true } });
    expect(stage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Nothing to add: the files are already under version control" }),
    );
  });
});

describe("Add to .gitignore", () => {
  it("ignores the Project view's selection while it has focus, and not otherwise", async () => {
    project.paths = ["/repo/dir/new.ts"];
    await getAction("vcs.ignoreShared")!.run({ arg: undefined, ctx: { vcsAvailable: true, projectViewFocus: true } });
    expect(ignore).toHaveBeenCalledWith(["/repo/dir/new.ts"], "gitignore");
    ignore.mockClear();
    await getAction("vcs.ignoreShared")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
    expect(ignore).not.toHaveBeenCalledWith(["/repo/dir/new.ts"], "gitignore");
  });
});
