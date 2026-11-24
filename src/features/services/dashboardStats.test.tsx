import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainer, DockerContainerStats, DockerSnapshot, DockerVolume } from "@/platform/ipc";
import { ToolWindowShownProvider } from "@/workbench/contributions";

const backend = vi.hoisted(() => ({
  stats: vi.fn(),
  volumeSizes: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      dockerContainerStats: backend.stats,
      dockerVolumeSizes: backend.volumeSizes,
    },
  };
});

import {
  bytesToDecimalUnits,
  ComposeProjectDashboard,
  CONTAINER_STATS_POLL_MS,
  ContainerDashboard,
  VOLUME_SIZES_POLL_MS,
  VolumeDashboard,
} from "./dashboard";

const ok = <T,>(data: T) => ({ status: "ok" as const, data });

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
  backend.volumeSizes.mockReset();
  backend.volumeSizes.mockResolvedValue(ok({}));
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
    let resolvePending: ((v: ReturnType<typeof ok<DockerContainerStats>>) => void) | undefined;
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
    // Container without volume mounts does not poll dockerVolumeSizes.
    expect(backend.volumeSizes).not.toHaveBeenCalled();
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

describe("live volume disk usage polling", () => {
  const pgVolume: DockerVolume = {
    name: "shop_pgdata",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/shop_pgdata/_data",
    composeProject: "shop",
    scope: "local",
    labels: {
      "com.docker.compose.project": "shop",
      "com.docker.compose.volume": "pgdata",
    },
  };

  const cacheVolume: DockerVolume = {
    name: "shop_redis",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/shop_redis/_data",
    composeProject: "shop",
    scope: "local",
    labels: {
      "com.docker.compose.project": "shop",
      "com.docker.compose.volume": "redis",
    },
  };

  const snapshotWithVolumes: DockerSnapshot = {
    ...snapshot,
    volumes: [pgVolume, cacheVolume],
  };

  it("formats decimal byte totals like Docker CLI output", () => {
    expect(bytesToDecimalUnits(0)).toBe("0B");
    expect(bytesToDecimalUnits(512)).toBe("512B");
    expect(bytesToDecimalUnits(145_400)).toBe("145.4kB");
    expect(bytesToDecimalUnits(1_500_000_000)).toBe("1.5GB");
  });

  it("auto-refreshes VolumeDashboard disk usage every 30s while visible and pauses when hidden", async () => {
    let sample = 0;
    backend.volumeSizes.mockImplementation(async () => {
      sample += 1;
      return ok({ shop_pgdata: `${sample * 100}kB` });
    });

    const { rerender } = render(
      <ToolWindowShownProvider value={true}>
        <VolumeDashboard conn="default" volume={pgVolume} snapshot={snapshotWithVolumes} />
      </ToolWindowShownProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(1);
    expect(backend.volumeSizes).toHaveBeenLastCalledWith({ kind: "default" });
    expect(screen.getByText("100kB")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOLUME_SIZES_POLL_MS);
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(2);
    expect(screen.getByText("200kB")).toBeInTheDocument();

    // Pauses while hidden and resumes when visible again.
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOLUME_SIZES_POLL_MS * 3);
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(2);

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(3);
    expect(screen.getByText("300kB")).toBeInTheDocument();

    // Stops polling when the Services tool window is closed.
    rerender(
      <ToolWindowShownProvider value={false}>
        <VolumeDashboard conn="default" volume={pgVolume} snapshot={snapshotWithVolumes} />
      </ToolWindowShownProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOLUME_SIZES_POLL_MS * 3);
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(3);
  });

  it("refreshes ComposeProjectDashboard per-volume chips and summed banner disk usage every 30s", async () => {
    backend.stats.mockResolvedValue(ok(makeStats("1.00%")));
    backend.volumeSizes
      .mockResolvedValueOnce(ok({ shop_pgdata: "1.2GB", shop_redis: "300MB" }))
      .mockResolvedValueOnce(ok({ shop_pgdata: "1.5GB", shop_redis: "500MB" }));

    render(
      <ToolWindowShownProvider value={true}>
        <ComposeProjectDashboard
          conn="default"
          project="shop"
          containers={[runningContainer, stoppedContainer]}
          snapshot={snapshotWithVolumes}
        />
      </ToolWindowShownProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(1);
    expect(screen.getByText("pgdata · local · 1.2GB")).toBeInTheDocument();
    expect(screen.getByText("redis · local · 300MB")).toBeInTheDocument();
    expect(screen.getByText("1.5GB")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOLUME_SIZES_POLL_MS);
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(2);
    expect(screen.getByText("pgdata · local · 1.5GB")).toBeInTheDocument();
    expect(screen.getByText("redis · local · 500MB")).toBeInTheDocument();
    expect(screen.getByText("2GB")).toBeInTheDocument();
  });

  it("refreshes ContainerDashboard mounted volume sizes every 30s without overlapping slow calls", async () => {
    backend.stats.mockResolvedValue(ok(makeStats("1.00%")));
    let resolveSlow: ((v: ReturnType<typeof ok<Record<string, string>>>) => void) | undefined;
    backend.volumeSizes
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce(ok({ shop_pgdata: "256.8kB" }));

    const inspectJson = JSON.stringify([
      {
        Created: "2026-04-20T05:00:00Z",
        State: { Status: "running", Pid: 100, StartedAt: "2026-04-20T05:00:01Z" },
        HostConfig: { RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
        Config: { Entrypoint: [], Cmd: ["postgres"], Env: [], Labels: {} },
        Mounts: [
          {
            Type: "volume",
            Name: "shop_pgdata",
            Source: "/var/lib/docker/volumes/shop_pgdata/_data",
            Destination: "/var/lib/postgresql/data",
            Mode: "z",
            RW: true,
          },
          {
            Type: "bind",
            Source: "/work/shop/init.sql",
            Destination: "/docker-entrypoint-initdb.d/init.sql",
            Mode: "ro",
            RW: false,
          },
        ],
        NetworkSettings: { Ports: {}, Networks: {} },
      },
    ]);

    render(
      <ToolWindowShownProvider value={true}>
        <ContainerDashboard
          conn="default"
          container={{ ...runningContainer, mounts: ["shop_pgdata"] }}
          snapshot={snapshotWithVolumes}
          inspectText={inspectJson}
        />
      </ToolWindowShownProvider>,
    );

    expect(backend.volumeSizes).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOLUME_SIZES_POLL_MS * 1.5);
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSlow!(ok({ shop_pgdata: "145.4kB" }));
      await Promise.resolve();
    });
    expect(screen.getByText("145.4kB")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOLUME_SIZES_POLL_MS);
    });
    expect(backend.volumeSizes).toHaveBeenCalledTimes(2);
    expect(screen.getByText("256.8kB")).toBeInTheDocument();
  });
});
