import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const empty = () => Promise.resolve({ status: "ok" as const, data: [] });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: empty,
      vcsBranches: empty,
      vcsBranchInfo: () => Promise.resolve({ status: "ok", data: { upstream: null } }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

import { LogScope } from "../LogScope";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import {
  closeLogTab,
  emptyFilters,
  installGitLog,
  openLogTab,
  recentLogFilters,
  reloadLog,
  selectGitTab,
  setLogBranches,
  setLogFilters,
  updateLogOptions,
  useGitLog,
} from "../logStore";
import { useVcs } from "../store";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useVcs.setState({ root: "/repo", repo: "/repo", roots: ["/repo"] });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    logTabs: [],
    commits: [],
    rows: [],
    filters: emptyFilters(),
    selection: [],
    selected: null,
    done: true,
    generation: useGitLog.getState().generation + 1,
  });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
});

afterEach(async () => {
  for (const tab of useGitLog.getState().logTabs) closeLogTab(tab.id);
  await reloadLog();
});

function Probe({ name }: { name: string }) {
  const text = useGitLog((s) => s.filters.text);
  const hash = useLogOptions((s) => s.showHash);
  return <button onClick={() => setLogFilters({ text: `${name} edited` })}>{`${name}: ${text} / hash ${hash}`}</button>;
}

describe("independent log views", () => {
  it("keeps both scopes visible and activates the target before applying an edit", async () => {
    setLogFilters({ text: "main" });
    const other = openLogTab("log", "Other");
    setLogFilters({ text: "other" });
    updateLogOptions({ showHash: true });
    selectGitTab("log");
    render(
      <>
        <LogScope id="log">
          <Probe name="main" />
        </LogScope>
        <LogScope id={other}>
          <Probe name="other" />
        </LogScope>
      </>,
    );
    expect(screen.getByText("main: main / hash false")).toBeInTheDocument();
    expect(screen.getByText("other: other / hash true")).toBeInTheDocument();
    const button = screen.getByText("other: other / hash true");
    await act(async () => {
      fireEvent.pointerDown(button);
      fireEvent.click(button);
    });
    expect(useGitLog.getState().shownLog).toBe(other);
    expect(screen.getByText("main: main / hash false")).toBeInTheDocument();
    expect(screen.getByText("other: other edited / hash true")).toBeInTheDocument();
  });

  it("restores each tab's filters and options after leaving and reopening the project", async () => {
    const off = installGitLog();
    setLogFilters({ text: "main" });
    const other = openLogTab("log", "Other");
    setLogFilters({ paths: ["/repo/src"], branches: ["feature/.*"] });
    useGitLog.setState({
      fragments: {
        expanded: new Set(["/repo\0expanded"]),
        collapsed: new Set(["/repo\0collapsed"]),
        merges: new Set(["/repo\0merge"]),
      },
      selected: "/repo\0expanded",
      selection: ["/repo\0expanded"],
    });
    updateLogOptions({ showHash: true, diffLocation: "bottom" });
    selectGitTab("log");
    await reloadLog();
    useVcs.setState({ root: "/another", repo: "/another", roots: ["/another"] });
    useVcs.setState({ root: "/repo", repo: "/repo", roots: ["/repo"] });
    expect(useGitLog.getState().filters.text).toBe("main");
    expect(useGitLog.getState().fragments.expanded.size).toBe(0);
    selectGitTab(other);
    expect(useGitLog.getState().filters).toMatchObject({ paths: ["/repo/src"], branches: ["feature/.*"] });
    expect(useLogOptions.getState()).toMatchObject({ showHash: true, diffLocation: "bottom" });
    expect([...useGitLog.getState().fragments.expanded]).toEqual(["/repo\0expanded"]);
    expect([...useGitLog.getState().fragments.collapsed]).toEqual(["/repo\0collapsed"]);
    expect([...useGitLog.getState().fragments.merges]).toEqual(["/repo\0merge"]);
    expect(useGitLog.getState().selection).toEqual(["/repo\0expanded"]);
    off();
  });

  it("remembers branch-only filters and clears a range when a named branch replaces it", async () => {
    setLogBranches(["main..feature"]);
    await reloadLog();
    expect(useGitLog.getState().filters).toMatchObject({ range: "main..feature", branches: [] });
    setLogFilters({ branches: ["main"] });
    await reloadLog();
    expect(useGitLog.getState().filters.range).toBeNull();
    setLogBranches(["feature"]);
    await reloadLog();
    expect(recentLogFilters()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branches: ["main"] }),
        expect.objectContaining({ range: "main..feature" }),
      ]),
    );
  });
});
