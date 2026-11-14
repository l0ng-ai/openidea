import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BranchesPopupHost, showBranchesPopup, useBranchesPopup } from "../BranchWidget";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsTags: async () => ({ status: "ok", data: [] }) } };
});

afterEach(() => {
  useBranchesPopup.setState({ open: false });
  localStorage.clear();
});

it("opens Git Branches without a mounted toolbar widget", () => {
  render(<BranchesPopupHost />);
  act(showBranchesPopup);
  expect(screen.getByRole("dialog", { name: "Git Branches" })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(useBranchesPopup.getState().open).toBe(false);
});

it("opens Git Branches at the size it was last resized to", () => {
  localStorage.setItem("openidea.vcs.branchesPopup.size", JSON.stringify({ w: 520, h: 600 }));
  render(<BranchesPopupHost />);
  act(showBranchesPopup);
  const popup = screen.getByRole("dialog", { name: "Git Branches" });
  expect([popup.style.width, popup.style.height]).toEqual(["520px", "600px"]);
  popup.getBoundingClientRect = () => new DOMRect(0, 0, 520, 600);
  fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize" }), { button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: 40, clientY: -100 });
  fireEvent.pointerUp(window);
  expect(JSON.parse(localStorage.getItem("openidea.vcs.branchesPopup.size")!)).toEqual({ w: 560, h: 500 });
});

it("keeps the groups the user expanded per project across sessions", async () => {
  const { useProject } = await import("@/platform/project");
  const { useVcs } = await import("../store");
  const branch = (name: string, remote: boolean, current = false) => ({
    name,
    current,
    remote,
    upstream: null,
    ahead: 0,
    behind: 0,
    lastCommitMs: null,
    commit: "1111111",
  });
  useProject.setState({ project: { root: "/work/app" } as never });
  useVcs.setState({
    available: true,
    root: "/work/app",
    repo: "/work/app",
    roots: ["/work/app"],
    branchesLoaded: true,
    branches: [branch("main", false, true), branch("origin/main", true), branch("origin/release", true)],
  });
  // A previous session expanded Remote, which is collapsed by default.
  localStorage.setItem(
    "openidea.vcs.branchesPopup.expanded:/work/app",
    JSON.stringify({ single: [["group:remote", true]], multi: [] }),
  );
  render(<BranchesPopupHost />);
  act(showBranchesPopup);
  const remote = screen.getByText("Remote").closest("[aria-expanded]")!;
  expect(remote).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("release")).toBeInTheDocument();

  fireEvent.click(screen.getByText("Local"));
  expect(screen.getByText("Local").closest("[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
  expect(JSON.parse(localStorage.getItem("openidea.vcs.branchesPopup.expanded:/work/app")!)).toEqual({
    single: [
      ["group:remote", true],
      ["group:local", false],
    ],
    multi: [],
  });
});
