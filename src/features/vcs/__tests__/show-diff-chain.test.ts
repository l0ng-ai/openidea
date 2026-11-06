import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";
import { getAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { registerVcsActions } from "../actions";
import { useVcs } from "../store";
import { useCommit } from "../commitStore";
import { initialChangelists, useChangelists } from "../changelists";
import { chainNeighbour } from "../diffInput";

const opened = vi.hoisted(() => vi.fn());
const project = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput: opened }),
  projectViewSelection: () => project.paths,
}));
vi.mock("../comparePaths", () => ({ showDirectoryWorkingDiff: async () => false }));

const status = (name: string): FileStatus => ({
  path: `/repo/${name}`,
  relPath: name,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
});
const vcs = useVcs.getState();
const commit = useCommit.getState();
const lists = useChangelists.getState();
let unregister: () => void;

beforeEach(() => {
  opened.mockClear();
  project.paths = [];
  setContext("activeToolWindow", "");
  const files = [status("z.ts"), status("b.ts"), status("a.ts"), status("other.ts")];
  useVcs.setState({ root: "/repo", roots: ["/repo"], status: files, byPath: new Map(files.map((f) => [f.path, f])) });
  useCommit.setState({ groupByDir: false, selection: [] });
  const state = initialChangelists();
  state.lists.push({ id: "other", name: "Other", comment: "" });
  state.files = { "other.ts": "other" };
  useChangelists.setState({ state });
  unregister = registerVcsActions();
});

afterEach(() => {
  unregister();
  setContext("activeToolWindow", "");
  useVcs.setState(vcs);
  useCommit.setState(commit);
  useChangelists.setState(lists);
});

it("keeps sibling files in tree order when Show Diff opens a changed file", async () => {
  await getAction("vcs.showDiff")!.run({ arg: "/repo/b.ts", ctx: { vcsAvailable: true } });
  const data = opened.mock.calls[0]![0].data;
  expect(data.path).toBe("/repo/b.ts");
  expect(data.chain.map((d: { path: string }) => d.path)).toEqual(["/repo/a.ts", "/repo/b.ts", "/repo/z.ts"]);
  expect(chainNeighbour(data, 1)).toMatchObject({ path: "/repo/z.ts", reveal: "first" });
  expect(chainNeighbour(data, -1)).toMatchObject({ path: "/repo/a.ts", reveal: "last" });
});

it("keeps an explicit line on the opened file without carrying it into neighbouring requests", async () => {
  await getAction("vcs.showDiff")!.run({ arg: { path: "/repo/b.ts", line: 12 }, ctx: { vcsAvailable: true } });
  const data = opened.mock.calls[0]![0].data;
  expect(data.line).toBe(12);
  expect(chainNeighbour(chainNeighbour(data, 1)!, -1)!.line).toBeUndefined();
});

it("opens a file outside the changes list without unrelated siblings", async () => {
  await getAction("vcs.showDiff")!.run({ arg: "/repo/clean.ts", ctx: { vcsAvailable: true } });
  expect(opened.mock.calls[0]![0].data.path).toBe("/repo/clean.ts");
  expect(opened.mock.calls[0]![0].data.chain).toBeUndefined();
});

it("follows directory order rather than global filename order", async () => {
  const files = [status("a.ts"), status("src/z.ts"), status("src/nested/b.ts"), status("other.ts")];
  useVcs.setState({ status: files, byPath: new Map(files.map((f) => [f.path, f])) });
  useCommit.setState({ groupByDir: true });
  await getAction("vcs.showDiff")!.run({ arg: "/repo/src/z.ts", ctx: { vcsAvailable: true } });
  expect(opened.mock.calls[0]![0].data.chain.map((d: { path: string }) => d.path)).toEqual([
    "/repo/src/nested/b.ts",
    "/repo/src/z.ts",
    "/repo/a.ts",
  ]);
});

it("keeps repository grouping in a changelist's chain", async () => {
  const files = [status("z.ts"), status("module/b.ts"), status("module/a.ts")];
  useVcs.setState({ status: files, roots: ["/repo", "/repo/module"] });
  await getAction("vcs.showDiff")!.run({ arg: "/repo/module/b.ts", ctx: { vcsAvailable: true } });
  expect(opened.mock.calls[0]![0].data.chain.map((d: { path: string }) => d.path)).toEqual([
    "/repo/z.ts",
    "/repo/module/a.ts",
    "/repo/module/b.ts",
  ]);
});

it("shows the selected change rather than a Project view selection kept from earlier", async () => {
  // The Project view keeps its selection while the Commit window has focus: ⌘D must open
  // the file selected in the changes tree, not the one still selected there.
  project.paths = ["/repo/z.ts"];
  setContext("activeToolWindow", "commit");
  useCommit.setState({ selection: ["/repo/b.ts"] });
  await getAction("vcs.showDiff")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
  expect(opened.mock.calls[0]![0].data.path).toBe("/repo/b.ts");
});

it("shows a Project view selection outside the changes tree", async () => {
  project.paths = ["/repo/z.ts"];
  setContext("activeToolWindow", "project");
  await getAction("vcs.showDiff")!.run({ arg: undefined, ctx: { vcsAvailable: true } });
  expect(opened.mock.calls[0]![0].data.path).toBe("/repo/z.ts");
});
