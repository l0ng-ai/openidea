import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";
import { BranchFilterPopup } from "../BranchFilterPopup";
import { useFavoriteBranches } from "../branchOps";

const branch = (name: string, extra: Partial<Branch> = {}) =>
  ({ name, remote: false, current: false, ...extra }) as Branch;

const branches = [
  branch("main", { current: true }),
  branch("feature/demo"),
  branch("origin/HEAD", { remote: true }),
  branch("origin/develop", { remote: true }),
];

function renderPopup(onSelect = vi.fn()) {
  render(
    <BranchFilterPopup
      anchor={document.body}
      branches={branches}
      selected={["main"]}
      onSelect={onSelect}
      onSelectMany={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { input: screen.getByRole("textbox", { name: "Search branches" }), onSelect };
}

const rowTexts = () => screen.getAllByRole("option").map((o) => o.textContent);

afterEach(() => {
  localStorage.clear();
  useFavoriteBranches.setState({ key: "", names: null });
});

describe("branch filter popup", () => {
  it("lists HEAD and the favorites, with Local and Remote collapsed until opened; no remote HEAD", () => {
    renderPopup();
    // `main` is a favorite by default.
    expect(screen.getByText("Favorites")).toBeTruthy();
    expect(rowTexts()).toEqual(["HEAD (Current Branch)", "main", "Local", "Remote"]);
    fireEvent.click(screen.getByText("Remote"));
    expect(screen.getByText("Remote").closest("[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("origin/develop")).toBeTruthy();
    expect(screen.queryByText("origin/HEAD")).toBeNull();
  });

  it("shows the user's favorite branches, local and remote, under Favorites by name", () => {
    localStorage.setItem("openidea.vcs.favoriteBranches:", JSON.stringify(["origin/develop", "feature/demo"]));
    renderPopup();
    expect(rowTexts()).toEqual(["HEAD (Current Branch)", "feature/demo", "origin/develop", "Local", "Remote"]);
    const input = screen.getByRole("textbox", { name: "Search branches" });
    // Right opens a group on the keyboard, Left closes it. Inside, the current branch, then favorites.
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(rowTexts()).toEqual([
      "HEAD (Current Branch)",
      "feature/demo",
      "origin/develop",
      "Local",
      "main",
      "feature/demo",
      "Remote",
    ]);
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(rowTexts()).toEqual(["HEAD (Current Branch)", "feature/demo", "origin/develop", "Local", "Remote"]);
  });

  it("searches case-insensitively and hides groups without a match", () => {
    const { input, onSelect } = renderPopup();
    fireEvent.change(input, { target: { value: "DEVELOP" } });
    expect(screen.getByText("Remote")).toBeTruthy();
    expect(screen.queryByText("Local")).toBeNull();
    expect(screen.queryByText("main")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("origin/develop");
  });

  it("moves over section headers with the arrow keys", () => {
    const { input, onSelect } = renderPopup();
    // HEAD → (Favorites header skipped) → main
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("main");
  });

  it("highlights fuzzy matches and shows an empty state", () => {
    const { input } = renderPopup();
    fireEvent.change(input, { target: { value: "fdm" } });
    expect(document.querySelectorAll("mark")).toHaveLength(3);
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("No matching branches")).toBeTruthy();
  });
});
