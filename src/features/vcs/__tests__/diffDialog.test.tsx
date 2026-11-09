import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

const editor = vi.hoisted(() => vi.fn());
vi.mock("../DiffEditor", () => ({
  DiffEditor: (props: { input: { data: { path: string; embedded?: boolean } }; onJumpToSource?: () => void }) => {
    editor(props);
    return <div data-testid="diff-view" data-path={props.input.data.path} />;
  },
}));

import type { Settings } from "@/bindings";
import { useProject } from "@/platform/project";
import { registerAction } from "@/platform/actions";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { provideEditorService } from "@/workbench/contributions";
import { ChangesTree, nodeMenu } from "../CommitView";
import type { ChangeNode } from "../changes";
import { VcsDialogHost } from "../dialogs";
import { useVcs } from "../store";
import { openDiffDialog } from "../diffDialog";

const modified = (path: string) => ({
  path,
  relPath: path.slice(3),
  staged: null,
  unstaged: "modified" as const,
  renamedFrom: null,
});

/** Editor tabs: none may open behind the modal Commit dialog. */
const openDiff = vi.fn(async () => undefined);
provideEditorService({ openInput: openDiff } as never);

/** Activates (double-clicks) the file row the way a user does. */
function activateFile(name: string) {
  const row = screen.getByText(name).closest('[role="treeitem"]')!;
  act(() => fireEvent.doubleClick(row));
}

/** The diff window of this test: named by the file's diff title (the tree may double-activate). */
const diffDialogs = async () => (await screen.findAllByRole("dialog", { name: /\(HEAD ↔ Your version\)/ })).at(-1)!;

describe("Commit dialog diff window (#1863)", () => {
  beforeEach(() => {
    // The Commit dialog exists with "Use non-modal commit interface" unticked.
    useProject.setState({ settings: { vcs: { commit: { nonModal: false } } } as Settings });
    // The dialog stack is module state: close whatever a previous test left open.
    for (const close of screen.queryAllByRole("button", { name: "Close" })) act(() => fireEvent.click(close));
    useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [modified("/p/a.ts")] });
  });

  it("opens the diff in a front dialog, not in an editor tab", async () => {
    render(
      <>
        <ChangesTree mode="dialog" />
        <VcsDialogHost />
      </>,
    );
    activateFile("a.ts");
    await diffDialogs();
    expect(openDiff).not.toHaveBeenCalled();
    expect(screen.getByTestId("diff-view")).toHaveAttribute("data-path", "/p/a.ts");
    expect(editor.mock.calls.at(-1)?.[0].input.data.embedded).toBe(true);
  });

  it("keeps the changes tree mounted underneath and closes on Esc", async () => {
    render(
      <>
        <ChangesTree mode="dialog" />
        <VcsDialogHost />
      </>,
    );
    activateFile("a.ts");
    await diffDialogs();
    expect(screen.getByRole("tree", { name: "Changes" })).toBeTruthy();
    act(() => fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByRole("dialog", { name: /\(HEAD ↔ Your version\)/ })).toBeNull();
    // Back at the Commit dialog's tree, unchanged.
    expect(screen.getByRole("tree", { name: "Changes" })).toBeTruthy();
  });

  it("opens the context menu's Show Diff in a front dialog, not in an editor tab", async () => {
    render(<VcsDialogHost />);
    const f = modified("/p/a.ts");
    const node: ChangeNode = { key: f.path, type: "file", label: "a.ts", group: "changes", files: [f], path: f.path };
    const item = nodeMenu([node], ["/p"], { roots: [node] }).find(
      (i) => i.kind !== "separator" && "label" in i && i.label === "Show Diff",
    );
    expect(item).toMatchObject({ label: "Show Diff" });
    act(() => (item as { run: () => void }).run());
    await diffDialogs();
    expect(openDiff).not.toHaveBeenCalled();
    expect(screen.getByTestId("diff-view")).toHaveAttribute("data-path", "/p/a.ts");
  });

  it("moves along the chain inside the dialog instead of opening editor tabs", async () => {
    useVcs.setState({ status: [modified("/p/a.ts"), modified("/p/b.ts")] });
    render(
      <>
        <ChangesTree mode="dialog" />
        <VcsDialogHost />
      </>,
    );
    activateFile("a.ts");
    await diffDialogs();
    const neighbour = { path: "/p/b.ts", left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } };
    act(() => editor.mock.calls.at(-1)?.[0].onNeighbour(neighbour));
    expect(openDiff).not.toHaveBeenCalled();
    expect(screen.getByTestId("diff-view")).toHaveAttribute("data-path", "/p/b.ts");
    await screen.findByRole("dialog", { name: "b.ts (HEAD ↔ Your version)" });
  });

  it("closes on Jump to Source so the editor it opens is not hidden behind it", async () => {
    render(
      <>
        <ChangesTree mode="dialog" />
        <VcsDialogHost />
      </>,
    );
    activateFile("a.ts");
    await diffDialogs();
    act(() => editor.mock.calls.at(-1)?.[0].onJumpToSource());
    expect(screen.queryByRole("dialog", { name: /\(HEAD ↔ Your version\)/ })).toBeNull();
    expect(screen.getByRole("tree", { name: "Changes" })).toBeTruthy();
  });

  it.each(["body", "footer", "titlebar"])("owns the close shortcut with %s focus", (location) => {
    const closeTab = vi.fn();
    const unregister = registerAction({ id: "editor.closeTab", title: "Close Tab", run: closeTab });
    const keymap = useKeymap.getState();
    useKeymap.setState({ overrides: { "editor.closeTab": ["Meta+W"], "toolwindow.closeContent": ["Meta+W"] } });
    const uninstall = installKeyboardDispatcher(window);
    render(<VcsDialogHost />);
    let close: () => void;
    try {
      act(() => {
        close = openDiffDialog({ path: "/p/a.ts", left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } });
      });
      const dialog = screen.getByRole("dialog", { name: /\(HEAD ↔ Your version\)/ });
      const target = dialog.querySelector(
        location === "body"
          ? "[data-testid='diff-view']"
          : location === "footer"
            ? "[data-dialog-footer] button"
            : "[data-dialog-titlebar] button",
      )!;
      fireEvent.keyDown(target, { key: "w", code: "KeyW", metaKey: true });
      expect(closeTab).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: /\(HEAD ↔ Your version\)/ })).toBeNull();
    } finally {
      act(() => close?.());
      uninstall();
      unregister();
      useKeymap.setState(keymap);
    }
  });
});

it("opens an editor tab instead once the non-modal interface is chosen", async () => {
  useProject.setState({ settings: null });
  useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [modified("/p/a.ts")] });
  render(<ChangesTree mode="dialog" />);
  activateFile("a.ts");
  await vi.waitFor(() => expect(openDiff).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("dialog", { name: /\(HEAD ↔ Your version\)/ })).toBeNull();
});
