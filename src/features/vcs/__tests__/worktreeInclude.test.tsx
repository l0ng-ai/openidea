import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { VcsDialogHost } from "../dialogs";
import { showNewWorktree } from "../NewWorktreeDialog";
import { registerWorktreeIncludeEditor } from "../worktreeInclude";

const mocks = vi.hoisted(() => ({
  worktrees: vi.fn(),
  info: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  add: vi.fn(),
  openFile: vi.fn(),
  openPaths: vi.fn(),
  onOpenTabsChange: vi.fn(),
  attach: vi.fn(),
  save: vi.fn(),
  edit: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranches: async () => ok([{ name: "main", remote: false, current: true }]),
      vcsTags: async () => ok([]),
      vcsWorktrees: mocks.worktrees,
      vcsWorktreeInclude: mocks.info,
      fsCreateFileBytes: mocks.create,
      fsProbe: async () => ok({ binary: false, tooLarge: false, size: 15 }),
      fsReadText: mocks.read,
      vcsAddWorktree: mocks.add,
    },
  };
});
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({
    openFile: mocks.openFile,
    openPaths: mocks.openPaths,
    onOpenTabsChange: mocks.onOpenTabsChange,
  }),
  notifications: () => ({ notify: vi.fn() }),
}));
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  attachDocument: mocks.attach,
}));

const ok = <T,>(data: T) => ({ status: "ok", data });
const path = "/source/.worktreeinclude";
let off: () => void;
let exists: boolean;
let content: string;
let tabChange: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ project: { root: "/source" } as never });
  mocks.worktrees.mockReset().mockResolvedValue(ok([{ path: "/source", main: true, branch: "main" }]));
  exists = false;
  content = "";
  mocks.info.mockImplementation(async () => ok({ path, exists }));
  mocks.create.mockImplementation(async (_path, bytes) => {
    exists = true;
    content = new TextDecoder().decode(Uint8Array.from(bytes));
    return ok(null);
  });
  mocks.read.mockImplementation(async () => ok(content));
  mocks.add.mockResolvedValue(ok({}));
  mocks.openFile.mockResolvedValue(undefined);
  mocks.openPaths.mockReturnValue([path]);
  mocks.onOpenTabsChange.mockImplementation((fn) => {
    tabChange = fn;
    return vi.fn();
  });
  mocks.attach.mockImplementation(async () => ({
    text: () => content,
    edit: mocks.edit,
    dirty: () => true,
    save: mocks.save,
    release: mocks.release,
  }));
  mocks.save.mockResolvedValue(undefined);
  mocks.edit.mockImplementation(({ insert }) => {
    content += insert;
  });
  off = registerWorktreeIncludeEditor();
  render(<VcsDialogHost />);
});

afterEach(() => {
  off();
  useProject.setState(useProject.getInitialState(), true);
});

it("suggests a worktree outside the project when the selected repository is a submodule", async () => {
  useProject.setState({ project: { root: "/work/project" } as never });
  const submodule = "/work/project/vendor/module";
  mocks.worktrees.mockResolvedValue(ok([{ path: submodule, main: true, branch: null, submodule: true }]));
  act(() => showNewWorktree({ repo: submodule }));
  expect(
    await screen.findByText(
      "This worktree has its own checkout, separate from the submodule in the parent repository.",
    ),
  ).toBeVisible();
  expect(screen.getByLabelText("Name:")).toHaveValue("module-main");
  expect(screen.getByLabelText("Location:")).toHaveValue("/work");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
});

it("creates and opens the include file, then saves it and resumes with the branch and location intact", async () => {
  act(() => showNewWorktree({ repo: "/source" }));
  const create = await screen.findByRole("button", { name: "Create .worktreeinclude…" });
  expect(screen.getByRole("checkbox", { name: "Copy local files listed in .worktreeinclude" })).toBeDisabled();
  fireEvent.change(await screen.findByLabelText("New branch name"), { target: { value: "test-branch" } });
  fireEvent.change(screen.getByLabelText("Name:"), { target: { value: "manual-name" } });
  fireEvent.change(screen.getByLabelText("Location:"), { target: { value: "/tmp/worktrees" } });
  fireEvent.click(create);
  await waitFor(() => expect(mocks.openFile).toHaveBeenCalledWith(path, { focus: true }));
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(content).toContain("\n.worktreeinclude\n.env\n.env.local\n");
  expect(screen.queryByRole("dialog", { name: "New Worktree" })).toBeNull();

  await act(() => executeAction("vcs.worktree.returnToDialog"));
  const edit = await screen.findByRole("button", { name: "Edit .worktreeinclude…" });
  expect(edit).toBeEnabled();
  expect(mocks.save).toHaveBeenCalledWith({ exact: true });
  expect(screen.getByLabelText("New branch name")).toHaveValue("test-branch");
  expect(screen.getByLabelText("Name:")).toHaveValue("manual-name");
  expect(screen.getByLabelText("Location:")).toHaveValue("/tmp/worktrees");
  expect(screen.getByRole("checkbox", { name: "Copy local files listed in .worktreeinclude" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(mocks.add).toHaveBeenCalledWith(
      "/source",
      "/tmp/worktrees/manual-name",
      "refs/heads/main",
      "test-branch",
      true,
      null,
    ),
  );
});

it("adds only missing OpenIDEA patterns and lets closing the include tab cancel the draft", async () => {
  exists = true;
  content = ".env.local\n/.openidea/settings.toml\n";
  act(() => showNewWorktree({ repo: "/source" }));
  fireEvent.change(screen.getByLabelText("Name:"), { target: { value: "abandoned" } });
  fireEvent.click(await screen.findByRole("button", { name: "Edit .worktreeinclude…" }));
  await waitFor(() => expect(mocks.openFile).toHaveBeenCalled());
  await act(() => executeAction("vcs.worktree.addOpenIdeaSettings"));
  await waitFor(() => expect(content).toContain("\n.openidea/run.local.toml\n"));
  expect(content.match(/\.openidea\/settings\.toml/g)).toHaveLength(1);
  expect(mocks.create).not.toHaveBeenCalled();

  mocks.openPaths.mockReturnValue([]);
  act(() => tabChange());
  await act(() => executeAction("vcs.worktree.returnToDialog"));
  expect(mocks.save).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "New Worktree" })).toBeNull();
});
