import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { confirmProjectTrust } from "@/platform/projectTrust";
import { executeAction } from "@/platform/actions";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { invokeLocal } from "@/platform/tauriCore";
import { OverlayHost } from "@/workbench/OverlayHost";
import { useContributions } from "@/workbench/contributions";
import { activate } from "./index";

const status = vi.fn();
const decide = vi.fn();
vi.mock("@/platform/tauriCore", async (original) => ({
  ...(await original<typeof import("@/platform/tauriCore")>()),
  invokeLocal: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      projectTrustStatus: (path: string) => status(path),
      projectTrustSet: (...args: unknown[]) => decide(...args),
      projectCurrent: async () => null,
    },
  };
});
let dispose: () => void;
beforeEach(() => {
  vi.mocked(invokeLocal).mockReset();
  status
    .mockReset()
    .mockImplementation(async (root: string) => ({ status: "ok", data: { root, trusted: false, decided: false } }));
  decide.mockReset().mockResolvedValue({ status: "ok", data: null });
  useProject.setState({ project: null });
  dispose = activate();
});
afterEach(() => dispose());

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
