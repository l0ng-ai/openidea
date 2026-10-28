import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchFilterPopup } from "../BranchFilterPopup";

describe("branch filter popup", () => {
  it("searches branches case-insensitively and selects a matching branch with the keyboard", () => {
    const onSelect = vi.fn();
    render(
      <BranchFilterPopup
        anchor={document.body}
        branches={["main", "origin/develop", "feature/demo"]}
        selected={["main"]}
        onSelect={onSelect}
        onSelectMany={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Search branches" });
    fireEvent.change(input, { target: { value: "DEVELOP" } });
    expect(screen.getByRole("option", { name: "origin/develop" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "main" })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("origin/develop");
    fireEvent.change(input, { target: { value: "fdm" } });
    const fuzzy = screen.getByRole("option", { name: "feature/demo" });
    expect(fuzzy.querySelectorAll("mark")).toHaveLength(3);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("feature/demo");
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("No matching branches")).toBeTruthy();
  });
});
