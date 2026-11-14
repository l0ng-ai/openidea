import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { confirmProjectTrust } from "@/platform/projectTrust";
import { executeAction } from "@/platform/actions";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { invokeLocal } from "@/platform/tauriCore";
import { OverlayHost } from "@/workbench/OverlayHost";
import { useContributions, useSettingsPages } from "@/workbench/contributions";
import { activate } from "./index";

const status = vi.fn();
const decide = vi.fn();
vi.mock("@/platform/tauriCore", async (original) => ({
  ...(await original<typeof import("@/platform/tauriCore")>()),
  invokeLocal: vi.fn(),
}));
const addLocation = vi.fn();
const listDecisions = vi.fn();
const pickFolder = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFolder }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      projectTrustStatus: (path: string) => status(path),
      projectTrustSet: (...args: unknown[]) => decide(...args),
      projectTrustList: () => listDecisions(),
      projectTrustAddLocation: (...args: unknown[]) => addLocation(...args),
      remoteTrustStatus: () => remoteStatus(),
      remoteTrustSet: (...args: unknown[]) => remoteDecide(...args),
      projectCurrent: async () => null,
    },
  };
});
const remoteStatus = vi.fn();
const remoteDecide = vi.fn();
let dispose: () => void;
beforeEach(() => {
  vi.mocked(invokeLocal).mockReset();
  status
    .mockReset()
    .mockImplementation(async (root: string) => ({ status: "ok", data: { root, trusted: false, decided: false } }));
  decide.mockReset().mockResolvedValue({ status: "ok", data: null });
  remoteStatus
    .mockReset()
    .mockResolvedValue({ status: "ok", data: { root: "/srv/app", trusted: false, decided: false } });
  remoteDecide.mockReset().mockResolvedValue({ status: "ok", data: null });
  addLocation.mockReset().mockResolvedValue({ status: "ok", data: null });
  listDecisions.mockReset().mockResolvedValue({ status: "ok", data: { projects: [], locations: [], restricted: [] } });
  pickFolder.mockReset().mockResolvedValue(null);
  useProject.setState({ project: null });
  dispose = activate();
});
afterEach(() => {
  dispose();
  useRemote.setState({ session: null });
});

function remoteSession() {
  useRemote.setState({
    session: { target: { kind: "ssh", config: "box" }, root: "/srv/app", host: "box", os: "linux", commands: [] },
  });
}

it("asks in a remote window when only the server has a trust decision, and records the answer on both", async () => {
  remoteSession();
  status.mockResolvedValue({ status: "ok", data: { root: "/srv/app", trusted: true, decided: true } });
  render(<OverlayHost />);
  const opening = confirmProjectTrust("/srv/app");
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Preview in Restricted Mode" }));
  await act(async () => opening);
  expect(decide).toHaveBeenCalledWith("/srv/app", false, false);
  expect(remoteDecide).toHaveBeenCalledWith(false);
});

it("reuses a remote project's decision once this machine has the same one", async () => {
  remoteSession();
  status.mockResolvedValue({ status: "ok", data: { root: "/srv/app", trusted: true, decided: true } });
  remoteStatus.mockResolvedValue({ status: "ok", data: { root: "/srv/app", trusted: true, decided: true } });
  render(<OverlayHost />);
  await act(async () => confirmProjectTrust("/srv/app"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(remoteDecide).not.toHaveBeenCalled();
});

it("revokes a remote project's trust on this machine too", async () => {
  remoteSession();
  useProject.setState({ project: { root: "/srv/app", name: "app", isGit: false, trusted: true, settings: {} } });
  await act(async () => executeAction("project.revokeTrust"));
  expect(decide).toHaveBeenCalledWith("/srv/app", false, false);
  expect(remoteDecide).toHaveBeenCalledWith(false);
});

it("offers three choices, cancels without a trust decision, and supports restricted preview", async () => {
  render(<OverlayHost />);
  const cancelled = confirmProjectTrust("/new").catch(() => "cancelled");
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Don't Open" }));
  expect(await cancelled).toBe("cancelled");
  expect(decide).not.toHaveBeenCalled();
  const preview = confirmProjectTrust("/new");
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Preview in Restricted Mode" }));
  await act(async () => preview);
  expect(decide).toHaveBeenCalledWith("/new", false, false);
});

it("saves the parent-folder choice and reuses a persisted decision", async () => {
  render(<OverlayHost />);
  const opening = confirmProjectTrust("/projects/new");
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("checkbox", { name: /Trust projects in/ }));
  fireEvent.click(screen.getByRole("button", { name: "Trust Project" }));
  await act(async () => opening);
  expect(decide).toHaveBeenCalledWith("/projects/new", true, true);
  status.mockResolvedValue({ status: "ok", data: { trusted: true, decided: true } });
  await act(async () => confirmProjectTrust("/projects/other"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("updates the running project's banner after a backend trust transition", async () => {
  useProject.setState({ project: { root: "/p", name: "P", isGit: false, trusted: false, settings: {} } });
  const Banner = useContributions.getState().workbenchBanners.get("project.restrictedMode")!.component;
  render(<Banner />);
  expect(screen.getByRole("status")).toHaveTextContent("Restricted Mode");
  await act(async () => executeAction("project.trust"));
  expect(decide).toHaveBeenCalledWith("/p", true, false);
  act(() => emitLocalIdeEvent({ type: "projectTrustChanged", root: "/p", trusted: true }));
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows and trusts the canonical folder when opening through a symlink", async () => {
  status.mockResolvedValue({ status: "ok", data: { root: "/real/projects/new", trusted: false, decided: false } });
  render(<OverlayHost />);
  const opening = confirmProjectTrust("/aliases/new");
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("checkbox", { name: /Trust projects in \/real\/projects/ }));
  fireEvent.click(screen.getByRole("button", { name: "Trust Project" }));
  await act(async () => opening);
  expect(decide).toHaveBeenCalledWith("/real/projects/new", true, true);
});

it("adds a picked folder as a trusted location from settings", async () => {
  const Page = useSettingsPages.getState().pages.get("projectTrust")!.component!;
  pickFolder.mockResolvedValue("/projects");
  addLocation.mockImplementation(async () => {
    listDecisions.mockResolvedValue({
      status: "ok",
      data: { projects: [], locations: ["/projects"], restricted: [] },
    });
    return { status: "ok", data: null };
  });
  render(<Page />);
  fireEvent.click(await screen.findByRole("button", { name: "Add folder…" }));
  await screen.findByText("/projects");
  expect(addLocation).toHaveBeenCalledWith("/projects");
  pickFolder.mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Add folder…" }));
  await act(async () => {});
  expect(addLocation).toHaveBeenCalledTimes(1);
});

it.each(["Trust Project", "Preview in Restricted Mode"])(
  "keeps a local opening's trust decision on the client: %s",
  async (button) => {
    const project = { root: "/remote", name: "Remote", isGit: false, trusted: true, settings: {} };
    useProject.setState({ project });
    vi.mocked(invokeLocal).mockResolvedValueOnce({ root: "/local", trusted: false, decided: false });
    render(<OverlayHost />);
    const opening = confirmProjectTrust("/local", "local");
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: button }));
    await act(async () => opening);
    expect(invokeLocal).toHaveBeenCalledWith("project_trust_status", { path: "/local" });
    expect(invokeLocal).toHaveBeenCalledWith("project_trust_set", {
      path: "/local",
      trusted: button === "Trust Project",
      folder: false,
    });
    expect(status).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(useProject.getState().project).toBe(project);
  },
);

it.each([false, true])("recovers an attached member whose trust is lost (decided=%s)", async (decided) => {
  useProject.setState({
    project: {
      root: "/primary",
      name: "primary",
      trusted: false,
      isGit: false,
      settings: {},
      workspace: { version: 1, name: "primary", projects: ["/primary", "/other"] },
    },
  });
  status.mockImplementation(async (root: string) => ({
    status: "ok",
    data: {
      root,
      trusted: root === "/primary",
      decided: root === "/primary" || decided,
    },
  }));
  const Banner = useContributions.getState().workbenchBanners.get("project.restrictedMode")!.component;
  render(
    <>
      <Banner />
      <OverlayHost />
    </>,
  );
  const button = await screen.findByRole("button", { name: "Trust Project" });
  await screen.findByText("/other");
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Trust and Open Project?" });
  expect(dialog).toHaveTextContent("/other");
  expect(decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Trust Project" }).at(-1)!);
  await act(async () => {});
  expect(decide).toHaveBeenCalledWith("/other", true, false);
});
