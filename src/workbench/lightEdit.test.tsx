import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useEditorRegistry } from "@/editor/api";
import { evaluateWhen } from "@/platform/context";
import { useProject } from "@/platform/project";
import { activateWorkbench } from "./activate";
import { registerStatusItem, registerTitleItem, registerToolWindow } from "./contributions";
import { EmptyEditor } from "./EditorArea";
import { chooseProjectWindow } from "./projectWindow";
import { Workbench } from "./Workbench";

/** A LightEdit window (loose files, no project) with project features registered as in a full window. */
describe("LightEdit window", () => {
  const disposers: Array<() => void> = [];
  beforeEach(() => {
    useProject.setState({ project: null, lightEdit: true, settings: null });
    useEditorRegistry.setState({ active: { ctx: { path: "/x/notes/todo.md" } } } as never);
    disposers.push(
      registerToolWindow({
        id: "project",
        title: "Project",
        icon: "folder",
        anchor: "left",
        order: 0,
        component: () => <div>project tree</div>,
      }),
      registerTitleItem({ id: "vcs.branch", align: "left", priority: 0, component: () => <span>branch widget</span> }),
      registerStatusItem({ id: "vcs.status", align: "right", priority: 1, component: () => <span>git status</span> }),
      registerStatusItem({
        id: "editor.caret",
        align: "right",
        priority: 2,
        component: () => <span>1:1</span>,
        lightEdit: true,
      }),
    );
  });
  afterEach(() => {
    disposers.splice(0).forEach((d) => d());
    useProject.setState({ project: null, lightEdit: false });
    useEditorRegistry.setState({ active: null });
  });

  it("shows the editor with the file name as title, without project features", () => {
    render(<Workbench />);
    expect(document.querySelector("[data-light-edit]")).not.toBeNull();
    expect(screen.getByText("todo.md")).toBeInTheDocument();
    expect(document.querySelector("[data-stripe-side]")).toBeNull();
    expect(screen.queryByText("branch widget")).toBeNull();
    const items = [...document.querySelectorAll("[data-status-item]")].map((el) => el.getAttribute("data-status-item"));
    expect(items).toEqual(["editor.caret"]);
    expect(screen.queryByText("Welcome to OpenIDEA")).toBeNull();
  });

  it("hints only at opening files in an empty editor", () => {
    render(<EmptyEditor />);
    expect(screen.getByText("Open File")).toBeInTheDocument();
    expect(screen.getByText("Drop files here to open them")).toBeInTheDocument();
    for (const project of ["Search Everywhere", "Go to File", "Recent Files", "Navigation Bar"])
      expect(screen.queryByText(project)).toBeNull();
  });

  it("keeps the navigation hints in a project window", () => {
    useProject.setState({ lightEdit: false });
    render(<EmptyEditor />);
    expect(screen.getByText("Go to File")).toBeInTheDocument();
    expect(screen.queryByText("Open File")).toBeNull();
  });

  it("sets the context keys that keep project actions off", () => {
    const dispose = activateWorkbench();
    expect(evaluateWhen("lightEdit")).toBe(true);
    expect(evaluateWhen("projectOpen")).toBe(false);
    useProject.setState({ lightEdit: false });
    expect(evaluateWhen("lightEdit")).toBe(false);
    dispose();
  });

  it("applies 'Open project in' when opening a project from it", async () => {
    useProject.setState({ settings: { general: { openProjectIn: "new" } } } as never);
    expect(await chooseProjectWindow("notes")).toBe("new");
    useProject.setState({ lightEdit: false });
    expect(await chooseProjectWindow("notes")).toBe("same");
  });
});
