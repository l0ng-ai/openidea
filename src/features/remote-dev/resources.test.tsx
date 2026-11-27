import { act, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import type { HostMetrics, RemoteSession } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { disableRemote, enableRemote, useRemote } from "@/platform/remote";
import { RemoteResources, RemoteResourcesDashboard } from "./RemoteResources";
import {
  compactResourceText,
  diskUsedPercent,
  formatRate,
  memoryPercent,
  refreshRemoteResources,
  sparklineGeometry,
  summarizePressure,
  syncRemoteResourcesSession,
  useRemoteResources,
} from "./resources";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const sampleMetrics: HostMetrics = {
  cpuPercent: 34.2,
  cpuCores: 16,
  loadAverage: [1.42, 1.18, 0.95],
  memoryUsedBytes: 6 * GB,
  memoryTotalBytes: 16 * GB,
  netRxBytesPerSec: 1.5 * MB,
  netTxBytesPerSec: 256 * 1024,
  diskReadBytesPerSec: 4 * MB,
  diskWriteBytesPerSec: 12 * MB,
  diskAvailableBytes: 84 * GB,
  diskTotalBytes: 200 * GB,
  uptimeMs: 7_620_000,
  processes: [
    { category: "app", label: "Backend", detail: null, pid: 100, processes: 1, bytes: 52 * MB, cpuPercent: 1.8 },
    {
      category: "languageServer",
      label: "rust-analyzer",
      detail: "openidea",
      pid: 200,
      processes: 2,
      bytes: 1400 * MB,
      cpuPercent: 42,
    },
    {
      category: "process",
      label: "pnpm run dev",
      detail: "Run",
      pid: 300,
      processes: 4,
      bytes: 380 * MB,
      cpuPercent: 15,
    },
  ],
  externalProcesses: [{ pid: 900, name: "dockerd", cpuPercent: 6.4, memoryBytes: 820 * MB }],
};

const sshSession = (host = "me@devbox", commands = ["host_metrics", "host_end_process"]): RemoteSession => ({
  target: { kind: "ssh", config: host },
  root: "/home/me/openidea",
  host,
  os: "linux",
  commands,
  idlePolicy: null,
  takenOver: false,
});

afterEach(() => {
  disableRemote();
  useRemote.setState({ session: null, lost: null, takenOver: false, reconnecting: false });
  syncRemoteResourcesSession(null);
  clearMocks();
});

describe("remote resource calculations", () => {
  it("keeps network and disk badges hidden when healthy and surfaces them on saturation", () => {
    const calm = summarizePressure(sampleMetrics, 18);
    expect(calm.level).toBe("normal");
    expect(calm.netSaturated).toBe(false);
    expect(calm.diskSaturated).toBe(false);

    const highRtt = summarizePressure(sampleMetrics, 320);
    expect(highRtt.level).toBe("warn");
    expect(highRtt.netSaturated).toBe(true);

    const lowDisk = summarizePressure({ ...sampleMetrics, diskAvailableBytes: 800 * MB, diskTotalBytes: 100 * GB }, 18);
    expect(lowDisk.diskLevel).toBe("danger");
    expect(lowDisk.diskSaturated).toBe(true);
  });

  it("formats compact pill text, percentages and transfer rates", () => {
    expect(compactResourceText(sampleMetrics)).toBe("34% · 6G");
    expect(memoryPercent(sampleMetrics)).toBe(37.5);
    expect(diskUsedPercent(sampleMetrics)).toBeCloseTo(58);
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(512 * 1024)).toBe("512 KB/s");
    expect(formatRate(null)).toBe("–");
  });

  it("builds bounded sparkline SVG paths and keeps idle noise flat under minCeiling", () => {
    expect(sparklineGeometry([null, null], 100, 24)).toBeNull();
    const single = sparklineGeometry([50], 100, 23, { fixedMax: 100 });
    expect(single?.line).toBe("M0,11.5 L100,11.5");

    // 100 B/s idle traffic against a 256 KB/s ceiling stays near the bottom edge (y ≈ 21.5 of 23).
    const idle = sparklineGeometry([100, 120], 100, 23, { minCeiling: 256 * 1024 });
    expect(idle?.line).toBe("M0,21.5 L100,21.5");
  });
});

describe("remote resources widget and dashboard", () => {
  it("stays inactive for local windows and legacy servers without host_metrics", async () => {
    let metricCalls = 0;
    mockIPC((cmd) => {
      if (cmd === "host_metrics") metricCalls += 1;
      return sampleMetrics;
    });

    const { container, rerender } = render(<RemoteResources />);
    expect(container.textContent).toBe("");

    act(() => enableRemote(sshSession("me@legacy", ["doc_close"])));
    rerender(<RemoteResources />);
    await act(async () => refreshRemoteResources(false));
    expect(container.textContent).toBe("");
    expect(metricCalls).toBe(0);
  });

  it("polls via remote_invoke, opens the dashboard and ends only OpenIDEA child processes", async () => {
    const remoteCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    useProject.setState((s) => ({
      project: s.project
        ? { ...s.project, trusted: true }
        : ({ name: "openidea", displayName: "openidea", root: "/home/me/openidea", trusted: true } as never),
    }));
    mockIPC((cmd, payload) => {
      if (cmd === "remote_invoke") {
        const p = payload as { cmd: string; args: string };
        const parsed = JSON.parse(p.args) as Record<string, unknown>;
        remoteCalls.push({ cmd: p.cmd, args: parsed });
        if (p.cmd === "host_metrics") return JSON.stringify(sampleMetrics);
        if (p.cmd === "host_end_process") return JSON.stringify(true);
      }
      return null;
    });

    act(() => enableRemote(sshSession("deng@thinkpad")));
    render(<RemoteResources />);

    await act(async () => {
      await refreshRemoteResources(false);
    });
    expect(remoteCalls[0]).toEqual({ cmd: "host_metrics", args: { includeProcesses: false } });
    const pill = screen.getByRole("button", { name: /Remote host resources:/ });
    expect(pill.textContent).toContain("34% · 6G");
    expect(pill.textContent).not.toContain("Net");
    expect(pill.textContent).not.toContain("Disk");

    await act(async () => {
      fireEvent.click(pill);
      await refreshRemoteResources(true);
    });

    expect(screen.getByText("SSH: deng@thinkpad")).toBeTruthy();
    expect(screen.getByText("16 cores · load 1.42 · 1.18 · 0.95")).toBeTruthy();
    expect(screen.getByText("6G / 16G")).toBeTruthy();
    expect(screen.getByText("84 GB free")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Language servers" }).textContent).toContain("rust-analyzer");
    expect(screen.getByRole("group", { name: "Other host processes" }).textContent).toContain("dockerd");

    // Backend and external host processes are never endable; child processes confirm before ending.
    expect(screen.queryByRole("button", { name: "End Process Backend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End Process dockerd" })).toBeNull();
    const endLsp = screen.getByRole("button", { name: "End Process rust-analyzer" });
    await act(async () => {
      fireEvent.click(endLsp);
    });
    const confirmDialog = screen.getByRole("dialog", { name: "End Remote Process" });
    expect(confirmDialog.textContent).toContain("End 'rust-analyzer' (PID 200) and its child processes");

    // Cancelling does not end the process.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(remoteCalls.some((c) => c.cmd === "host_end_process")).toBe(false);

    // Confirming ends the process via host_end_process.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End Process rust-analyzer" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End Process" }));
    });
    expect(remoteCalls).toContainEqual({ cmd: "host_end_process", args: { pid: 200 } });
  });

  it("hides End Process buttons in Restricted Mode and drops stale metrics on host switch", async () => {
    useProject.setState((s) => ({
      project: s.project
        ? { ...s.project, trusted: false }
        : ({ name: "openidea", displayName: "openidea", root: "/home/me/openidea", trusted: false } as never),
    }));
    render(
      <RemoteResourcesDashboard
        hostLabel="SSH: untrusted"
        metrics={sampleMetrics}
        rttMs={24}
        history={[{ cpuPercent: 34, memoryPercent: 37.5, netBytesPerSec: 1000, diskBytesPerSec: 2000, rttMs: 24 }]}
      />,
    );
    expect(screen.queryByRole("button", { name: /End Process/ })).toBeNull();

    let resolveSlow!: (v: string) => void;
    mockIPC((cmd) => {
      if (cmd === "remote_invoke") {
        return new Promise<string>((r) => {
          resolveSlow = r;
        });
      }
      return null;
    });
    act(() => enableRemote(sshSession("host-a")));
    const inflight = refreshRemoteResources(false);
    act(() => enableRemote(sshSession("host-b")));
    resolveSlow(JSON.stringify(sampleMetrics));
    await act(async () => inflight);
    expect(useRemoteResources.getState().metrics).toBeNull();
  });
});
