import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServiceTab } from "@/bindings";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import { ServicePane } from "../views/ServicePane";
import { bumpView } from "../views/viewStore";

afterEach(() => setPluginsBackend(null));

const log = {
  program: "kubectl",
  args: ["logs", "x"],
  toggles: [{ id: "ts", label: "Timestamps", args: ["--timestamps"] }],
};
const tabs: ServiceTab[] = [
  { id: "log", label: "Log", body: { kind: "log", value: log } },
  { id: "inspect", label: "Inspect", body: { kind: "text", value: "a: 1" } },
];

function backend(detail: () => ServiceTab[] = () => tabs) {
  const stops: ReturnType<typeof vi.fn>[] = [];
  const b = {
    ...createMemoryPluginsBackend([]),
    serviceDetail: vi.fn(async () => detail()),
    serviceLog: vi.fn<PluginsBackend["serviceLog"]>(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    }),
  };
  setPluginsBackend(b);
  return { b, stops };
}

describe("ServicePane", () => {
  it("switches tabs without calling the plugin", async () => {
    const { b } = backend();
    const user = userEvent.setup();
    render(<ServicePane pluginId="kube" view="pods" itemKey="pod:a" />);
    await user.click(await screen.findByRole("tab", { name: "Inspect" }));
    expect(screen.getByRole("document").textContent).toBe("a: 1");
    expect(b.serviceDetail).toHaveBeenCalledTimes(1);
  });

  it("follows a log tab by node and tab, and restarts it on a toggle", async () => {
    const { b, stops } = backend();
    const user = userEvent.setup();
    const { unmount } = render(<ServicePane pluginId="kube" view="pods" itemKey="pod:a" />);
    await waitFor(() => expect(b.serviceLog).toHaveBeenCalledTimes(1));
    expect(b.serviceLog.mock.calls[0]?.slice(0, 5)).toEqual(["kube", "pods", "pod:a", "log", new Set()]);
    await user.click(screen.getByRole("switch", { name: "Timestamps" }));
    expect(b.serviceLog).toHaveBeenCalledTimes(2);
    expect(b.serviceLog.mock.calls[1]?.[4]).toEqual(new Set(["ts"]));
    expect(stops.at(0)).toHaveBeenCalled();
    unmount();
    expect(stops.at(1)).toHaveBeenCalled();
  });

  it("asks again on a refresh and restarts a log whose program changed", async () => {
    let args = ["logs", "x"];
    const { b, stops } = backend(() => [{ id: "log", label: "Log", body: { kind: "log", value: { ...log, args } } }]);
    render(<ServicePane pluginId="kube" view="pods" itemKey="pod:a" />);
    await waitFor(() => expect(b.serviceLog).toHaveBeenCalledTimes(1));
    args = ["logs", "y"];
    bumpView("kube", "pods");
    await waitFor(() => expect(b.serviceLog).toHaveBeenCalledTimes(2));
    expect(b.serviceDetail).toHaveBeenCalledTimes(2);
    expect(stops.at(0)).toHaveBeenCalled();
  });

  it("shows the plugin's error", async () => {
    const b = {
      ...createMemoryPluginsBackend([]),
      serviceDetail: vi.fn(async () => Promise.reject(new Error("no cluster"))),
    };
    setPluginsBackend(b);
    render(<ServicePane pluginId="kube" view="pods" itemKey="pod:a" />);
    expect(await screen.findByText("no cluster")).toBeTruthy();
  });
});
