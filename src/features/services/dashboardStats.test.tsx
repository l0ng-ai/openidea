import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainer, DockerContainerStats, DockerSnapshot } from "@/platform/ipc";
import { ToolWindowShownProvider } from "@/workbench/contributions";

const backend = vi.hoisted(() => ({
  stats: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      dockerContainerStats: backend.stats,
    },
  };
});

import { ComposeProjectDashboard, CONTAINER_STATS_POLL_MS, ContainerDashboard } from "./dashboard";

const ok = (data: DockerContainerStats) => ({ status: "ok" as const, data });

function makeStats(cpuPerc: string): DockerContainerStats {
  return {
    cpuPerc,
    memUsage: "128MiB / 2GiB",
    memPerc: "6.25%",
    netIo: "2.4MB / 980kB",
    blockIo: "12MB / 4.1MB",
    pids: "17",
  };
}

const runningContainer: DockerContainer = {
  id: "db-1",
  name: "shop-db-1",
  image: "postgres:16",
  command: "postgres",
  state: "running",
  status: "Up 15 minutes",
  ports: "",
  createdAt: "2026-04-20T05:00:00Z",
  composeProject: "shop",
  composeService: "db",
  composeWorkingDir: "/work/shop",
  composeFiles: ["/work/shop/docker-compose.yml"],
  mounts: [],
  networks: [],
};

const stoppedContainer: DockerContainer = {
  ...runningContainer,
  id: "api-1",
  name: "shop-api-1",
  state: "exited",
  status: "Exited (0) 2 minutes ago",
  composeService: "api",
};

const snapshot: DockerSnapshot = {
  availability: { kind: "ready", clientVersion: "28.0.1", serverVersion: "28.0.1", context: null },
  executable: "/usr/bin/docker",
  containers: [runningContainer, stoppedContainer],
  images: [],
  volumes: [],
  networks: [],
  errors: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  backend.stats.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("live container stats polling", () => {
  it("auto-refreshes Compose running services every 3s while visible and pauses when hidden", async () => {
    let sample = 0;
    backend.stats.mockImplementation(async (_ep, id: string) => {
      sample += 1;
      return ok(makeStats(`${sample * 5}.00%:${id}`));
    });

    const { rerender } = render(
      <ToolWindowShownProvider value={true}>
        <ComposeProjectDashboard
          conn="default"
          project="shop"
          containers={[runningContainer, stoppedContainer]}
          snapshot={snapshot}
        />
      </ToolWindowShownProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(backend.stats).toHaveBeenCalledTimes(1);
    expect(backend.stats).toHaveBeenLastCalledWith({ kind: "default" }, "db-1");
    expect(screen.getByText("5.00%:db-1")).toBeInTheDocument();

    // Advances 3s (`top` default interval) and refreshes automatically without clicking Refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTAINER_STATS_POLL_MS);
    });
    expect(backend.stats).toHaveBeenCalledTimes(2);
    expect(screen.getByText("10.00%:db-1")).toBeInTheDocument();

    // Pauses while the document is hidden and resumes immediately when visible again.
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTAINER_STATS_POLL_MS * 3);
    });
    expect(backend.stats).toHaveBeenCalledTimes(2);

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(backend.stats).toHaveBeenCalledTimes(3);
    expect(screen.getByText("15.00%:db-1")).toBeInTheDocument();

    // Stops polling when the Services tool window is hidden.
    rerender(
      <ToolWindowShownProvider value={false}>
        <ComposeProjectDashboard
          conn="default"
          project="shop"
          containers={[runningContainer, stoppedContainer]}
          snapshot={snapshot}
        />
      </ToolWindowShownProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTAINER_STATS_POLL_MS * 3);
    });
    expect(backend.stats).toHaveBeenCalledTimes(3);
  });

  it("auto-refreshes ContainerDashboard without overlapping slow stats calls", async () => {
    let resolvePending: ((v: ReturnType<typeof ok>) => void) | undefined;
    backend.stats
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          }),
      )
      .mockImplementationOnce(async () => ok(makeStats("22.50%")));

    render(<ContainerDashboard conn="default" container={runningContainer} snapshot={snapshot} inspectText={null} />);

    expect(backend.stats).toHaveBeenCalledTimes(1);
    // Slow first sample (4.5s > 3s): no overlapping second call starts while in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(backend.stats).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePending!(ok(makeStats("9.00%")));
      await Promise.resolve();
    });
    expect(screen.getByText("9.00%")).toBeInTheDocument();

    // Next sample runs 3s after the previous sample completed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTAINER_STATS_POLL_MS);
    });
    expect(backend.stats).toHaveBeenCalledTimes(2);
    expect(screen.getByText("22.50%")).toBeInTheDocument();
  });
});
