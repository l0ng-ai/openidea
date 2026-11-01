import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { data: { path: string } } }) => (
    <div data-testid="diff-preview" data-path={input.data.path} />
  ),
}));

import { LocalChangesView } from "../CommitView";
import { setDiffPreview, useCommit } from "../commitStore";
import { useVcs } from "../store";

describe("Local Changes diff preview (#710)", () => {
  beforeEach(() => {
    localStorage.clear();
    useCommit.setState({ diffPreview: true, selection: [] });
    useVcs.setState({ root: "/p", repo: "/p", roots: ["/p"], status: [] });
  });

  it("previews the single selected file's working-tree diff", () => {
    useCommit.setState({ selection: ["/p/src/a.ts"] });
    render(<LocalChangesView />);
    expect(screen.getByTestId("diff-preview").getAttribute("data-path")).toBe("/p/src/a.ts");
  });

  it("shows a placeholder until exactly one file is selected", () => {
    render(<LocalChangesView />);
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
    useCommit.setState({ selection: ["/p/a.ts", "/p/b.ts"] });
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
  });

  it("follows the selection", () => {
    useCommit.setState({ selection: ["/p/a.ts"] });
    render(<LocalChangesView />);
    expect(screen.getByTestId("diff-preview").getAttribute("data-path")).toBe("/p/a.ts");
    act(() => useCommit.setState({ selection: ["/p/b.ts"] }));
    expect(screen.getByTestId("diff-preview").getAttribute("data-path")).toBe("/p/b.ts");
    act(() => useCommit.setState({ selection: [] }));
    expect(screen.queryByTestId("diff-preview")).toBeNull();
  });

  it("turns off via the View Options toggle, persists, and keeps the tree alone", () => {
    useCommit.setState({ selection: ["/p/a.ts"] });
    render(<LocalChangesView />);
    act(() => setDiffPreview(false));
    expect(useCommit.getState().diffPreview).toBe(false);
    expect(screen.queryByTestId("diff-preview")).toBeNull();
    expect(screen.getByText("No local changes")).toBeTruthy();
    expect(localStorage.getItem("openidea.vcs.diffPreview")).toBe("false");
  });
});
