import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";
import { BranchFilterPopup } from "../BranchFilterPopup";

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

describe("branch filter popup", () => {
  it("groups HEAD, local and remote branches and leaves out the remote HEAD", () => {
    renderPopup();
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText("Remote")).toBeTruthy();
    expect(screen.getByText("origin/develop")).toBeTruthy();
    expect(screen.queryByText("origin/HEAD")).toBeNull();
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
    // HEAD → (Local header skipped) → main
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
