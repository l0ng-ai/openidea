import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const forwarded: Array<{ remotePort: number; localPort: number }> = [];
const ipc = vi.hoisted(() => ({
  remoteForwardedPorts: vi.fn(),
  remoteForwardPort: vi.fn(),
  remoteStopForwarding: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));

import { PortsView } from "./PortsView";
import { forwardPort, parsePort, usePorts } from "./ports";

ipc.remoteForwardedPorts.mockImplementation(async () => [...forwarded]);
ipc.remoteForwardPort.mockImplementation(async (remotePort: number) => {
  // 3000 is taken here: another local port.
  const port = { remotePort, localPort: remotePort === 3000 ? 53000 : remotePort };
  forwarded.push(port);
  return { status: "ok", data: port };
});
ipc.remoteStopForwarding.mockImplementation(async (remotePort: number) => {
  forwarded.splice(
    forwarded.findIndex((p) => p.remotePort === remotePort),
    1,
  );
  return { status: "ok", data: null };
});

afterEach(() => {
  cleanup();
  forwarded.length = 0;
  localStorage.clear();
  usePorts.setState({ ports: [] });
});

describe("Ports tool window", () => {
  it("accepts port numbers 1–65535 only", () => {
    expect(parsePort(" 8080 ")).toBe(8080);
    expect([parsePort("0"), parsePort("65536"), parsePort("80a"), parsePort("")]).toEqual([null, null, null, null]);
  });

  it("forwards a typed port, shows where it is reachable here, and stops it", async () => {
    render(<PortsView />);
    expect(screen.getByText("No forwarded ports")).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Remote port" });
    fireEvent.change(field, { target: { value: "70000" } });
    expect(screen.getByRole("button", { name: "Forward Port" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward Port" }));
    await screen.findByText("localhost:53000");
    expect(ipc.remoteForwardPort).toHaveBeenCalledWith(3000);
    expect(field).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Stop Forwarding Port 3000" }));
    await waitFor(() => expect(screen.getByText("No forwarded ports")).toBeInTheDocument());
  });
});

describe("restoring forwarded ports", () => {
  it("forwards the ports of this host and folder again after reconnecting", async () => {
    const { useRemote } = await import("@/platform/remote");
    const { forwardPort, restorePorts, savedPorts } = await import("./ports");
    useRemote.setState({
      session: { target: { kind: "ssh", config: "lh" }, root: "/srv/app", host: "h", os: "linux", commands: [] },
    });
    await forwardPort(8080);
    expect(savedPorts()).toEqual([8080]);
    // Reconnected: the new connection forwards nothing yet.
    forwarded.length = 0;
    ipc.remoteForwardPort.mockClear();
    await restorePorts();
    expect(ipc.remoteForwardPort).toHaveBeenCalledWith(8080);
    expect(usePorts.getState().ports).toEqual([{ remotePort: 8080, localPort: 8080 }]);
    // Another folder on the same host has its own list.
    useRemote.setState({
      session: { target: { kind: "ssh", config: "lh" }, root: "/srv/other", host: "h", os: "linux", commands: [] },
    });
    expect(savedPorts()).toEqual([]);
    useRemote.setState({
      session: { target: { kind: "wsl", distro: "lh" }, root: "/srv/app", host: "lh", os: "linux", commands: [] },
    });
    expect(savedPorts()).toEqual([]);
    useRemote.setState({ session: null });
  });
});

it("forwards and remembers ports of a dev container, per folder and configuration", async () => {
  const { useRemote } = await import("@/platform/remote");
  const { savedPorts } = await import("./ports");
  const container = (config: string) => ({
    target: { kind: "devContainer" as const, folder: "/w/app", config },
    root: "/workspaces/app",
    host: "app",
    os: "linux",
    commands: [],
  });
  ipc.remoteForwardPort.mockClear();
  useRemote.setState({ session: container("") });
  expect(await forwardPort(8000)).toEqual({ remotePort: 8000, localPort: 8000 });
  expect(ipc.remoteForwardPort).toHaveBeenCalledWith(8000);
  expect(savedPorts()).toEqual([8000]);
  useRemote.setState({ session: { ...container(""), root: "/another-workspace" } });
  expect(savedPorts()).toEqual([8000]);
  useRemote.setState({ session: container(".devcontainer/other/devcontainer.json") });
  expect(savedPorts()).toEqual([]);
  useRemote.setState({ session: null });
});

it("doesn't forward ports of a WSL project yet", async () => {
  const { useRemote } = await import("@/platform/remote");
  ipc.remoteForwardPort.mockClear();
  useRemote.setState({
    session: { target: { kind: "wsl", distro: "u" }, root: "/home/u", host: "u", os: "linux", commands: [] },
  });
  expect(await forwardPort(8080)).toBeNull();
  expect(ipc.remoteForwardPort).not.toHaveBeenCalled();
  useRemote.setState({ session: null });
});

it("restores manually forwarded container ports alongside configured ports", async () => {
  const { useRemote } = await import("@/platform/remote");
  const { restorePorts, savedPorts } = await import("./ports");
  const session = {
    target: { kind: "devContainer" as const, folder: "/w/app", config: "" },
    root: "/workspaces/app",
    host: "app",
    os: "linux",
    commands: [],
  };
  useRemote.setState({ session });
  await forwardPort(9000);
  expect(savedPorts()).toEqual([9000]);
  forwarded.splice(0, forwarded.length, { remotePort: 8000, localPort: 8000 });
  await restorePorts();
  expect(usePorts.getState().ports).toEqual([
    { remotePort: 8000, localPort: 8000 },
    { remotePort: 9000, localPort: 9000 },
  ]);
  useRemote.setState({ session: { ...session, target: { ...session.target, folder: "/w/other" } } });
  expect(savedPorts()).toEqual([]);
  useRemote.setState({ session: null });
});

it("does not display a previous session's delayed port response", async () => {
  const { useRemote } = await import("@/platform/remote");
  const { refreshPorts } = await import("./ports");
  let resolve!: (ports: typeof forwarded) => void;
  ipc.remoteForwardedPorts.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = refreshPorts(true);
  useRemote.setState({
    session: {
      target: { kind: "devContainer", folder: "/other", config: "" },
      root: "/workspaces/other",
      host: "other",
      os: "linux",
      commands: [],
    },
  });
  resolve([{ remotePort: 8000, localPort: 8000 }]);
  await pending;
  expect(usePorts.getState().ports).toEqual([]);
  useRemote.setState({ session: null });
});

it("reloads ports when switching directly between connected sessions", async () => {
  const { useRemote } = await import("@/platform/remote");
  const { activate } = await import("./index");
  const session = (folder: string) => ({
    target: { kind: "devContainer" as const, folder, config: "" },
    root: "/workspaces/app",
    host: "app",
    os: "linux",
    commands: [],
  });
  useRemote.setState({ session: session("/first") });
  forwarded.push({ remotePort: 8000, localPort: 8000 });
  const dispose = activate();
  try {
    await waitFor(() => expect(usePorts.getState().ports).toEqual([{ remotePort: 8000, localPort: 8000 }]));
    forwarded.splice(0, forwarded.length, { remotePort: 9000, localPort: 9000 });
    useRemote.setState({ session: session("/second") });
    await waitFor(() => expect(usePorts.getState().ports).toEqual([{ remotePort: 9000, localPort: 9000 }]));
  } finally {
    dispose();
    useRemote.setState({ session: null });
  }
});
