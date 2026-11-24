import type { ChangedFile, Commit, Settings } from "@/bindings";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vcsCommitFiles = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsCommitFiles: (repo: unknown, id: string) => vcsCommitFiles(repo, id),
      vcsTags: () => ok([]),
      vcsLog: () => ok([]),
      vcsConfigGet: () => ok(null),
    },
  };
});

import { useProject } from "@/platform/project";
import { provideEditorService } from "@/workbench/contributions";
import { diffInput } from "../diffInput";
import { CommitDetails } from "../log/CommitDetails";
import { toLogChanges } from "../logChanges";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const commit: Commit = {
  id: "c".repeat(40),
  shortId: "c".repeat(8),
  parents: ["p".repeat(40)],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary: "Change",
  message: "Change",
  refs: [],
};

const files: ChangedFile[] = [
  { path: "src/a.ts", kind: "modified", oldPath: null },
  { path: "src/b.ts", kind: "modified", oldPath: null },
];

/** The preview tab of the first file, as the editor would report it. */
const shownInput = diffInput(toLogChanges(files, commit, "/repo")[0]!.diff);
const openInput = vi.fn(async () => undefined);
const activeInput = vi.fn(() => shownInput);
provideEditorService({ activeInput, openInput } as never);

const diffAsEditorTab = (on: boolean) =>
  useProject.setState({ settings: { vcs: { diffAsEditorTab: on } } as Settings });

beforeEach(() => {
  useVcs.setState({ root: "/repo", repo: "/repo", roots: ["/repo"], available: true, branchesLoaded: true });
  useGitLog.setState({ commits: [commit], selected: commit.id, selection: [commit.id], filters: emptyFilters() });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  vcsCommitFiles.mockReset().mockResolvedValue({ status: "ok", data: files });
  openInput.mockClear();
  activeInput.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.removeItem("openidea.diff.allInOne");
  useGitLog.setState({ commits: [], selection: [], selected: null, filters: emptyFilters() });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  useProject.setState({ settings: null });
});

/** Selects the second file and lets the 120 ms preview delay pass. */
async function selectSecondFile() {
  const row = await screen.findByText("b.ts");
  vi.useFakeTimers();
  fireEvent.mouseDown(row);
  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
  });
}

describe("Git Log selection preview", () => {
  it("opens no preview tab when diffs open in a separate window", async () => {
    diffAsEditorTab(false);
    render(<CommitDetails commits={[commit]} />);
    await selectSecondFile();
    expect(activeInput).toHaveBeenCalled();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("previews the selected file in a tab when diffs open as editor tabs", async () => {
    diffAsEditorTab(true);
    render(<CommitDetails commits={[commit]} />);
    await selectSecondFile();
    expect(openInput).toHaveBeenCalledTimes(1);
    expect(openInput).toHaveBeenCalledWith(expect.objectContaining({ kind: "diff" }), {
      preview: true,
      focus: false,
    });
  });

  it("still previews when an all-in-one diff opens a tab despite the setting", async () => {
    diffAsEditorTab(false);
    localStorage.setItem("openidea.diff.allInOne", "true");
    render(<CommitDetails commits={[commit]} />);
    await selectSecondFile();
    expect(openInput).toHaveBeenCalledTimes(1);
  });
});
