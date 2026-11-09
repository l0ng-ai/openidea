import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BranchesPopupHost, showBranchesPopup, useBranchesPopup } from "../BranchWidget";

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsTags: async () => ({ status: "ok", data: [] }) } };
});

afterEach(() => useBranchesPopup.setState({ open: false }));

it("opens Git Branches without a mounted toolbar widget", () => {
  render(<BranchesPopupHost />);
  act(showBranchesPopup);
  expect(screen.getByRole("dialog", { name: "Git Branches" })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(useBranchesPopup.getState().open).toBe(false);
});
