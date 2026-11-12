import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Settings } from "@/platform/ipc";

const open = vi.fn();
const imported = vi.fn();

vi.mock("@/platform/dialog", () => ({ open: (...args: unknown[]) => open(...args) }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      settingsSet: vi.fn(async () => ({ status: "ok", data: {} })),
      settingsGet: vi.fn(async () => ({})),
      settingsGetGlobal: vi.fn(async () => ({})),
    },
  };
});

import { registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openProjectStructure, useSettingsDialog } from "../model/staging";
import { ProjectStructureDialog } from "../languages/ProjectStructurePage";

let disposeAction: () => void = () => {};

beforeEach(() => {
  open.mockReset();
  imported.mockReset();
  useProject.setState({
    settings: structuredClone(DEFAULT_SETTINGS) as Settings,
    project: { name: "demo", root: "/project" } as never,
  });
  setContext("projectOpen", true);
  setContext("workspaceOpen", false);
  disposeAction = registerAction({
    id: "maven.importExternal",
    title: "Import Module from Existing Sources",
    when: "projectOpen && !workspaceOpen",
    run: () => imported(),
  });
  render(<ProjectStructureDialog />);
  act(() => openProjectStructure("modules"));
});

afterEach(() => {
  disposeAction();
  act(() => useSettingsDialog.setState({ projectStructureOpen: false }));
  useProject.setState({ project: null, settings: null });
  setContext("projectOpen", false);
});

describe("Project Structure module overrides", () => {
  it("keeps an outside directory out of module overrides and names the import action", async () => {
    open.mockResolvedValue("/sibling/B");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add Module Overrides" }));
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, title: "Select Module Directory", defaultPath: "/project" }),
    );
    const note = screen.getByText(/Module overrides only apply to a directory inside the opened project/);
    expect(note).toHaveTextContent("Import Module from Existing Sources");
    expect(screen.queryByText("B")).not.toBeInTheDocument();
    expect(imported).not.toHaveBeenCalled();
  });

  it("still stores an in-project directory as a module override", async () => {
    open.mockResolvedValue("/project/mod");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add Module Overrides" }));
    });
    expect(screen.queryByText(/Module overrides only apply/)).not.toBeInTheDocument();
    expect(screen.getAllByText("mod").length).toBeGreaterThan(0);
  });

  it("imports an external Maven project from this page without the directory override picker", async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import Module from Existing Sources" }));
    });
    expect(imported).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});
