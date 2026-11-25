import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Commit_Serialize } from "@/bindings";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { DEFAULT_TODO_SETTINGS, useTodoSettings } from "@/platform/todo";
import { commitTodoRules } from "../commitTodo";
import { provideNotificationService } from "@/workbench/contributions";
import { installPostCommitChecks, startPostCommitChecks } from "../postCommitChecks";
import { PushCheckStatus } from "../PushCheckStatus";

const analyze = vi.hoisted(() => vi.fn());
vi.mock("../commitAnalysis", () => ({ analyzeCommittedChanges: analyze }));

let dispose: (() => void) | undefined;

afterEach(() => {
  cleanup();
  dispose?.();
  useProject.setState({ project: null });
  useTodoSettings.setState(DEFAULT_TODO_SETTINGS, true);
  vi.restoreAllMocks();
  analyze.mockReset();
});

it("checks consecutive commits together and shows the result only for the selected outgoing commits", async () => {
  const notify = vi.fn();
  const expire = vi.fn();
  provideNotificationService({ notify, expire });
  useProject.setState({ project: { root: "/p" } as NonNullable<ReturnType<typeof useProject.getState>["project"]> });
  dispose = installPostCommitChecks();
  const review = vi.fn();
  let finishEarlier!: (value: null) => void;
  analyze
    .mockReturnValueOnce(new Promise((resolve) => (finishEarlier = resolve)))
    .mockResolvedValueOnce({ severity: "error", text: "An error remains", fix: { label: "Review", run: review } })
    .mockResolvedValueOnce(null);
  vi.spyOn(commands, "vcsLog").mockImplementation(async (_repo, query) => ({
    status: "ok",
    data: [
      {
        id: query.branch,
        parents: [query.branch === "second" ? "first" : "second"],
      } as Commit_Serialize,
    ],
  }));

  const load = vi.spyOn(commands, "vcsCommitSelectionChanges").mockResolvedValue({ status: "ok", data: [] });
  const settings = { analyzeCode: true, todo: null };
  const earlier = startPostCommitChecks("/p", "first", settings);
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
  const outgoing = [{ repo: "/p", commits: [{ id: "first" }] }];
  const onReview = vi.fn();
  const view = render(<PushCheckStatus outgoing={outgoing} onReview={onReview} />);
  expect(screen.getByText("Post-commit checks are still running")).toBeVisible();

  await act(() => startPostCommitChecks("/p", "second", settings));
  expect(analyze.mock.calls[0]?.[1].aborted).toBe(true);
  expect(load).toHaveBeenLastCalledWith("/p", ["first", "second"], expect.anything());
  finishEarlier(null);
  await earlier;
  expect(screen.getByText("An error remains", { exact: false })).toBeVisible();
  await act(async () => screen.getByRole("button", { name: "Review" }).click());
  expect(onReview).toHaveBeenCalledOnce();
  expect(review).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledOnce();
  view.rerender(<PushCheckStatus outgoing={[{ repo: "/other", commits: [{ id: "first" }] }]} onReview={onReview} />);
  expect(screen.queryByText("Post-commit checks failed")).toBeNull();

  await act(() => startPostCommitChecks("/p", "third", settings));
  expect(load).toHaveBeenLastCalledWith("/p", ["first", "second", "third"], expect.anything());
  view.rerender(<PushCheckStatus outgoing={outgoing} onReview={onReview} />);
  expect(screen.queryByText("Post-commit checks failed")).toBeNull();
  expect(expire).toHaveBeenCalledWith("vcs.postCommitChecks:/p");
});

it("keeps the captured filter and reports unreadable files beside successful snapshot reads", async () => {
  provideNotificationService({ notify: vi.fn() });
  useProject.setState({ project: { root: "/p" } as NonNullable<ReturnType<typeof useProject.getState>["project"]> });
  dispose = installPostCommitChecks();
  const releaseFilter = { id: "release", name: "Release", patternIds: ["fixme"] };
  useTodoSettings.setState({ filters: [releaseFilter] });
  const rules = commitTodoRules(useTodoSettings.getState(), releaseFilter.id);
  const original = "Original\n";
  const committed = "// FIXME block release\n// TODO later\n";
  vi.spyOn(commands, "vcsCommitSelectionChanges").mockResolvedValue({
    status: "ok",
    data: [
      { path: "a.ts", kind: "modified", oldPath: null, before: "before", after: "after" },
      { path: "locked.ts", kind: "modified", oldPath: null, before: "before", after: "after" },
    ],
  });
  vi.spyOn(commands, "vcsFileAt").mockImplementation(async (path, rev) =>
    path.endsWith("/locked.ts") && rev === "after"
      ? { status: "error", error: { kind: "io", message: "Object unavailable", data: null } }
      : { status: "ok", data: rev === "after" ? committed : original },
  );
  vi.spyOn(commands, "vcsDiffEntries").mockResolvedValue({ status: "ok", data: [null] });
  vi.spyOn(commands, "vcsDiffHunks").mockResolvedValue([
    { kind: "modified", start: 0, lines: 2, oldStart: 0, oldLines: 1, oldText: original },
  ]);

  const check = startPostCommitChecks("/p", "after", { analyzeCode: false, todo: rules });
  useTodoSettings.setState({ filters: [] });
  await check;
  render(<PushCheckStatus outgoing={[{ repo: "/p", commits: [{ id: "after" }] }]} onReview={() => {}} />);
  expect(screen.getByText(/1 TODO item in committed changes\. Could not check 1 file/)).toBeVisible();
});
