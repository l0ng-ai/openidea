import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PROJECT_KINDS } from "../newProjectLanguages";
import { NewProjectOverlay, showNewProject } from "../NewProject";

vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "C:\\Users\\me\\Projects" }));

describe("New Project dialog", () => {
  it("lists every language with an icon and selects the requested one", async () => {
    render(<NewProjectOverlay />);
    act(() => showNewProject("python"));
    const dialog = await screen.findByRole("dialog", { name: "New Project" });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(PROJECT_KINDS.length);
    for (const option of options) expect(option.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Python" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Python" })).toBeTruthy();
    expect(dialog.querySelector("h2")?.textContent).toBe("Python");
    expect(screen.getByRole("button", { name: "Browse…" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Laravel" }).querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("option", { name: "PHP Empty Project" })).toBeTruthy();
  });

  it("shows PhpStorm-style options for Laravel, Vue, Composer and WordPress", async () => {
    render(<NewProjectOverlay />);
    act(() => showNewProject("laravel"));
    expect(await screen.findByRole("heading", { name: "New Project" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Initialize Git repo" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Starter Kit:" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Laravel Sail" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Pest Laravel plugin" })).toBeChecked();
    expect(screen.getByText("Spatie packages")).toBeTruthy();

    act(() => showNewProject("vuejs"));
    expect(await screen.findByRole("checkbox", { name: "Use the default project setup" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Vue CLI:" })).toHaveValue("npm create vue@latest");

    act(() => showNewProject("composer-package"));
    expect(await screen.findByText("No package selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    act(() => showNewProject("wordpress-plugin"));
    expect(await screen.findByRole("textbox", { name: "WordPress installation path:" })).toBeTruthy();
    expect(
      screen.getByText(
        "Please specify a valid WordPress root directory (directory should contain 'wp-admin' and 'wp-includes').",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });
});
