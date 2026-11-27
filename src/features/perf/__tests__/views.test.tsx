import { act, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it } from "vitest";
import type { AppMetrics } from "@/platform/ipc";
import { MemoryDetails } from "../MemoryStatus";
import { PerfOverlay } from "../PerfOverlay";
import { usePerf } from "../store";
import { perfActions } from "../actions";

const MB = 1024 * 1024;

const metrics: AppMetrics = {
  rssBytes: 412 * MB,
  heapBytes: 300 * MB,
  totalMemoryBytes: 2048 * MB,
  uptimeMs: 303_000,
  startup: { processToMainMs: 40, processToSetupMs: 120, setupMs: 3.2, firstIpcMs: 640 },
  projects: 1,
  openDocuments: 4,
  indexFiles: 1234,
  indexSymbols: 56789,
  indexing: false,
  languageServers: 2,
  syntax: { documents: 4, trees: 2, treeTextBytes: 2 * MB, hits: 10, incrementalParses: 5, fullParses: 2 },
  memory: [
    { category: "app", label: "Backend", detail: null, pid: 10, processes: 1, bytes: 60 * MB, cpuPercent: 4.25 },
    { category: "app", label: "Web content", detail: "idea", pid: 11, processes: 1, bytes: 300 * MB, cpuPercent: 1 },
    {
      category: "languageServer",
      label: "jdtls",
      detail: "idea",
      pid: 20,
      processes: 2,
      bytes: 900 * MB,
      cpuPercent: 0,
    },
    { category: "process", label: "codelldb", detail: null, pid: 30, processes: 1, bytes: 30 * MB, cpuPercent: null },
  ],
};

describe("perf views", () => {
  it("renders memory details", () => {
    render(<MemoryDetails metrics={metrics} />);
    const openidea = screen.getByRole("group", { name: "OpenIDEA" });
    expect(openidea.textContent).toContain("360 MB");
    expect(openidea.textContent).toContain("Web content");
    expect(openidea.textContent).toContain("300 MB");
    const servers = screen.getByRole("group", { name: "Language servers" });
    expect(servers.textContent).toContain("jdtls");
    expect(servers.textContent).toContain("idea");
    expect(servers.textContent).toContain("900 MB");
    expect(screen.getByRole("group", { name: "Debug adapters & processes" }).textContent).toContain("codelldb");
    expect(screen.getByText("1.3 GB")).toBeTruthy();
    expect(screen.getByText("1,234 files · 56,789 symbols")).toBeTruthy();
    expect(screen.getByText("2 / 4 docs · 2M")).toBeTruthy();
    expect(screen.getByText("10 / 5 / 2")).toBeTruthy();
    expect(screen.getByText("640 ms")).toBeTruthy();
    expect(screen.getByText("Backend malloc in use")).toBeTruthy();
    expect(screen.getByText("40 ms")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clear caches/ })).toBeTruthy();
    expect(openidea.textContent).toContain("5.3%");
    expect(servers.textContent).toContain("0%");
    expect(screen.getByTitle("PID 20 · 2 processes")).toBeTruthy();
  });

  it("ends language servers and processes, never OpenIDEA's own", async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "end_process") return true;
      if (cmd === "app_metrics") return metrics;
    });
    render(<MemoryDetails metrics={metrics} />);
    expect(screen.queryByRole("button", { name: "End Process Backend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End Process Web content" })).toBeNull();
    expect(screen.getByRole("button", { name: "End Process codelldb" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "End Process jdtls" })));
    expect(calls[0]).toEqual(["end_process", { pid: 20 }]);
    expect(calls.some(([cmd]) => cmd === "app_metrics")).toBe(true);
    clearMocks();
  });

  it("overlay is off by default and degrades without PerformanceObserver", async () => {
    const { container } = render(<PerfOverlay />);
    expect(container.textContent).toBe("");
    const toggle = perfActions().find((a) => a.id === "perf.toggleOverlay")!;
    await act(async () => void toggle.run({ ctx: {} }));
    expect(screen.getByLabelText("Performance overlay (dev diagnostics)")).toBeTruthy();
    await act(async () => void toggle.run({ ctx: {} }));
    expect(usePerf.getState().overlayOpen).toBe(false);
  });

  it("registers stable action ids", () => {
    expect(perfActions().map((a) => a.id)).toEqual([
      "perf.clearCaches",
      "perf.showMemory",
      "perf.toggleMemoryIndicator",
      "perf.toggleOverlay",
    ]);
  });
});
