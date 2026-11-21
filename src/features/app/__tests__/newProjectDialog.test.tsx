import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratorInfo } from "@/bindings";
import { NewProjectOverlay, showNewProject } from "../NewProject";

const mocks = vi.hoisted(() => ({
  freeName: vi.fn(),
  taken: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
}));
const empty: GeneratorInfo = {
  id: "empty",
  name: "Empty Project",
  group: "New Project",
  icon: "folder",
  order: 0,
  description: "An empty folder to add files to.",
  git: true,
  fields: [],
  dynamic: false,
};
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      scaffoldCatalog: () => Promise.resolve([empty]),
      scaffoldRequirements: () => Promise.resolve({ status: "ok", data: [] }),
      scaffoldFreeName: mocks.freeName,
      scaffoldTargetTaken: mocks.taken,
      scaffoldCreate: mocks.create,
    },
  };
});
vi.mock("../windows", async (original) => ({
  ...(await original<typeof import("../windows")>()),
  openProjectInWindow: mocks.open,
}));

const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
const nameInput = () => screen.getByLabelText("Name:");
const createButton = () => screen.getByRole("button", { name: "Create" });

describe("File › New Project… name and location", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("openidea.newProject.location", "/work/projects");
    mocks.freeName.mockImplementation(() => ok("untitled2"));
    mocks.taken.mockImplementation((_dir: string, name: string) => ok(name === "existing"));
    mocks.create.mockImplementation(() => ok("/work/projects/untitled2"));
    mocks.open.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("starts where the last project was created, named after the first free untitled folder", async () => {
    render(<NewProjectOverlay />);
    act(() => showNewProject());
    expect(screen.getByLabelText("Location:")).toHaveValue("/work/projects");
    await waitFor(() => expect(nameInput()).toHaveValue("untitled2"));
    expect(mocks.freeName).toHaveBeenCalledWith("/work/projects", "untitled");
  });

  it("marks a name whose folder already exists with files and disables Create", async () => {
    render(<NewProjectOverlay />);
    act(() => showNewProject());
    await waitFor(() => expect(nameInput()).toHaveValue("untitled2"));
    fireEvent.change(nameInput(), { target: { value: "existing" } });
    expect(await screen.findByText("A folder with this name already exists and is not empty")).toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(createButton()).toBeDisabled();

    fireEvent.change(nameInput(), { target: { value: "fresh" } });
    await waitFor(() => expect(createButton()).toBeEnabled());
    expect(screen.queryByText("A folder with this name already exists and is not empty")).toBeNull();
  });

  it("remembers the location of the project it created", async () => {
    render(<NewProjectOverlay />);
    act(() => showNewProject());
    await waitFor(() => expect(nameInput()).toHaveValue("untitled2"));
    fireEvent.change(screen.getByLabelText("Location:"), { target: { value: "/elsewhere" } });
    await waitFor(() => expect(createButton()).toBeEnabled());
    fireEvent.click(createButton());
    await waitFor(() => expect(mocks.open).toHaveBeenCalled());
    expect(localStorage.getItem("openidea.newProject.location")).toBe("/elsewhere");
  });
});
