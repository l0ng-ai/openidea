import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Branch, CompareResult } from "@/bindings";

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  cancel: vi.fn(),
  scope: vi.fn(),
  choose: vi.fn(),
  open: vi.fn(),
  show: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsComparePaths: mocks.compare,
      cancelRequest: mocks.cancel,
      vcsCompareScope: mocks.scope,
    },
  };
});
vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: unknown }) => <div data-testid="diff">{JSON.stringify(input)}</div>,
}));
import { ChangesBetweenDialog, comparisonEmpty } from "../operations";
import { revisionItems } from "../RevisionChooser";

const branch = (name: string, remote = false) => ({ name, remote, current: false, lastCommitMs: 0 }) as Branch;
const scope = { paths: ["/workspace"], repositories: null };
const result: CompareResult = {
  skippedPaths: ["/workspace/loose"],
  repositories: [
    {
      root: "/workspace/client",
      revision: "aaa",
      error: null,
      files: [{ path: "src/app.ts", kind: "modified", oldPath: null, added: 3, removed: 1 }],
    },
    { root: "/workspace/server", revision: null, error: "unknown revision", files: [] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancel.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("directory comparison", () => {
  it("offers shared branches plus each repository's local, remote and tag revisions", () => {
    const repos = [
      {
        root: "/workspace/client",
        branches: [branch("main"), branch("client-only"), branch("origin/main", true)],
        tags: ["v1"],
      },
      { root: "/workspace/server", branches: [branch("main"), branch("server-only")], tags: [] },
      { root: "/workspace/admin", branches: [branch("main")], tags: [] },
    ];
    const items = revisionItems(repos, "");
    expect(items.find((i) => i.rev === "main" && i.repositories?.length === 3)?.detail).toBe("in 3 repositories");
    expect(items.filter((i) => i.section).map((i) => i.rev)).toEqual(["client", "server", "admin"]);
    expect(items.find((i) => i.rev === "origin/main")?.repositories).toEqual(["/workspace/client"]);
    expect(items.find((i) => i.rev === "v1")?.repositories).toEqual(["/workspace/client"]);
    expect(revisionItems(repos, "client-only").some((i) => i.rev === "client-only" && i.repositories === null)).toBe(
      true,
    );
  });

  it("shows explicit empty results, skipped paths and repository-specific errors", async () => {
    mocks.compare.mockResolvedValue({
      status: "ok",
      data: { ...result, repositories: result.repositories.map((r) => ({ ...r, files: [] })) },
    });
    render(<ChangesBetweenDialog from={{ rev: "main", label: "main" }} to={null} scope={scope} onClose={() => {}} />);
    expect(await screen.findByText("No changes against main in 1 repository")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot compare server against main: unknown revision");
    expect(screen.getByText(/Skipped content/)).toHaveTextContent("/workspace/loose");
    expect(comparisonEmpty("main", 2)).toBe("No changes against main in 2 repositories");
  });

  it("groups the existing changes tree by repo, includes counts and loads a diff only on click", async () => {
    mocks.compare.mockResolvedValue({ status: "ok", data: result });
    render(<ChangesBetweenDialog from={{ rev: "main", label: "main" }} to={null} scope={scope} onClose={() => {}} />);
    expect(await screen.findByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("client")).toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.queryByTestId("diff")).toBeNull();
    fireEvent.mouseDown(screen.getByText("app.ts"), { button: 0 });
    expect(screen.getByTestId("diff")).toHaveTextContent('"rev":"aaa"');
    expect(screen.getByTestId("diff")).toHaveTextContent("/workspace/client/src/app.ts");
  });

  it("cancels the backend request when a running comparison is closed", async () => {
    mocks.compare.mockReturnValue(new Promise(() => {}));
    const view = render(
      <ChangesBetweenDialog from={{ rev: "main", label: "main" }} to={null} scope={scope} onClose={() => {}} />,
    );
    await waitFor(() => expect(mocks.compare).toHaveBeenCalled());
    const request = mocks.compare.mock.calls[0]![3];
    view.unmount();
    expect(mocks.cancel).toHaveBeenCalledWith(request);
  });
});
