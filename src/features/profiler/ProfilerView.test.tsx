import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Profile, ProfileMode } from "@/platform/ipc";
import { useI18n } from "@/platform/i18n";
import { ProfilerTabs, ProfilerView } from "./ProfilerView";
import { addSnapshot, resetProfiler, useProfiler } from "./store";

// all → Main.run → byte[] (the allocated type)
function profile(mode: ProfileMode, total: number): Profile {
  const unit = mode === "cpu" ? "ms" : mode === "allocations" ? "bytes" : "samples";
  const leaf = mode === "cpu" ? "Main.work" : "byte[]";
  return {
    profiler: "async-profiler",
    unit,
    mode,
    total,
    frames: [
      { name: "all", file: null, line: null, kind: "code" },
      { name: "Main.run", file: "/p/Main.java", line: 3, kind: "code" },
      { name: leaf, file: null, line: null, kind: mode === "cpu" ? "code" : "allocatedType" },
    ],
    nodes: [
      { frame: 0, total, selfWeight: 0, children: [1] },
      { frame: 1, total, selfWeight: 0, children: [2] },
      { frame: 2, total, selfWeight: total, children: [] },
    ],
    methods: [{ frame: 2, selfWeight: total, total }],
  };
}

beforeEach(() => {
  resetProfiler();
  useProfiler.setState({ tab: "flame" });
});
afterEach(() => useI18n.setState({ texts: {} }));

describe("ProfilerView", () => {
  it("allocation profile shows bytes and marks type frames", () => {
    addSnapshot("App", profile("allocations", 640_000_000));
    useProfiler.setState({ tab: "tree" });
    render(<ProfilerView />);

    const row = screen.getByText("byte[]").parentElement!;
    expect(within(row).getByText("allocated")).toBeInTheDocument();
    expect(within(row).getByText(/610\.4 MB/)).toBeInTheDocument();
    // The ordinary frame above it carries no mark.
    expect(within(screen.getByText("Main.run").parentElement!).queryByText("allocated")).toBeNull();
    expect(screen.getByText("async-profiler · 610.4 MB allocated")).toBeInTheDocument();
  });

  it("marks the allocated type in the flame graph and the method list", () => {
    addSnapshot("App", profile("allocations", 640_000_000));
    const flame = render(<ProfilerView />);
    expect(flame.getByRole("treeitem", { name: "byte[]" }).getAttribute("title")).toMatch(/^Allocated type\nbyte\[\]/);
    expect(flame.getByRole("treeitem", { name: "Main.run" }).getAttribute("title")).not.toMatch(/^Allocated type/);
    flame.unmount();

    useProfiler.setState({ tab: "methods" });
    render(<ProfilerView />);
    expect(within(screen.getByText("byte[]").parentElement!).getByText("allocated")).toBeInTheDocument();
  });

  it("summarises live objects with the sample size, singular and plural", () => {
    addSnapshot("App", profile("liveObjects", 184));
    const many = render(<ProfilerView />);
    expect(many.getByText("async-profiler · 184 live samples (≈ 512 KB each)")).toBeInTheDocument();
    many.unmount();

    resetProfiler();
    addSnapshot("App", profile("liveObjects", 1));
    render(<ProfilerView />);
    expect(screen.getByText("async-profiler · 1 live sample (≈ 512 KB)")).toBeInTheDocument();
  });

  it("notice is shown above the views", () => {
    addSnapshot("App", profile("liveObjects", 5), "Live objects may be stale.");
    render(<ProfilerView />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Live objects may be stale.");
    expect(status.compareDocumentPosition(screen.getByRole("tree", { name: "Flame graph" }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows the notice in the active locale", () => {
    useI18n.setState({ texts: { "Live objects may be stale.": "存活对象可能已过期。" } });
    addSnapshot("App", profile("liveObjects", 5), "Live objects may be stale.");
    render(<ProfilerView />);
    expect(screen.getByRole("status")).toHaveTextContent("存活对象可能已过期。");
  });

  it("shows no status line without a notice", () => {
    addSnapshot("App", profile("allocations", 10));
    render(<ProfilerView />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("cpu profile looks as before", () => {
    addSnapshot("App", profile("cpu", 120));
    useProfiler.setState({ tab: "tree" });
    render(<ProfilerView />);
    expect(screen.queryByText("allocated")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("async-profiler · 120 ms")).toBeInTheDocument();
  });

  it("names allocation snapshots in the tab strip", () => {
    addSnapshot("App", profile("cpu", 120));
    addSnapshot("App", profile("allocations", 10));
    addSnapshot("App", profile("liveObjects", 10));
    render(<ProfilerTabs />);
    const labels = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(labels).toEqual(["App · Live Objects", "App · Allocations", "App"]);
  });
});
