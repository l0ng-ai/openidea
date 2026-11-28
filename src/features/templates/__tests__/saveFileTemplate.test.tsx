import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _setActiveEditor } from "@/editor/api";
import type { ProjectInfo } from "@/platform/ipc";
import { getAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { activate } from "../index";
import { SaveFileTemplateDialogHost } from "../files/SaveFileTemplateDialog";
import type { FileTemplate } from "../files/model";
import {
  FILE_TEMPLATES_KEY,
  fileTemplates,
  reloadFileTemplates,
  saveFileTemplate,
  setTemplateScheme,
  useFileTemplates,
} from "../files/store";

const ACTION_ID = "templates.saveFileAsTemplate";
let view: EditorView | null = null;
let deactivate: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  useProject.setState({ project: null });
  reloadFileTemplates();
});

afterEach(() => {
  deactivate?.();
  deactivate = null;
  _setActiveEditor(null);
  view?.destroy();
  view = null;
  localStorage.clear();
  useProject.setState({ project: null });
  reloadFileTemplates();
});

function activateDialog(path = "/p/src/Example.test.tsx", saved = "const saved = true;\n", buffer = saved) {
  view = new EditorView({ state: EditorState.create({ doc: saved }), parent: document.body });
  view.dispatch({ changes: { from: 0, to: saved.length, insert: buffer } });
  _setActiveEditor({
    view,
    ctx: { doc: 1, path, language: "typescript", uiMode: "TypeScript", readOnly: false },
  });
  render(<SaveFileTemplateDialogHost />);
  deactivate = activate();
  const action = getAction(ACTION_ID)!;
  act(() => action.run({ ctx: {} }));
  return action;
}

const template = (id: string, name: string, body: string): FileTemplate => ({
  id,
  name,
  icon: "file",
  extension: "txt",
  nameStyle: "asis",
  kinds: [{ id: "default", label: "Default", body }],
});

describe("Save File as Template action and dialog", () => {
  it("registers a File action distinct from Save as Live Template", () => {
    deactivate = activate();
    expect(getAction(ACTION_ID)).toMatchObject({
      title: "Save File as Template…",
      category: "File",
    });
    expect(getAction(ACTION_ID)!.when).not.toContain("editorHasSelection");
    expect(getAction("code.saveAsLiveTemplate")!.title).toBe("Save as Live Template…");
  });

  it("prefills the file identity and unsaved buffer, then saves the edited template to Default", () => {
    const unsaved = "const edited = true;\n";
    const action = activateDialog("/p/src/Example.test.tsx", "const saved = true;\n", unsaved);
    expect(action.enabled?.({ ctx: {} })).toBe(true);
    expect(screen.getByRole("dialog", { name: "Save File as Template…" })).toBeInTheDocument();
    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("Example.test");
    expect(name).toHaveFocus();
    expect(screen.getByLabelText("Extension")).toHaveValue("tsx");
    expect(screen.getByLabelText("Template body")).toHaveValue(unsaved);

    fireEvent.change(name, { target: { value: "Edited component" } });
    fireEvent.change(screen.getByLabelText("Extension"), { target: { value: ".jsx" } });
    fireEvent.change(screen.getByLabelText("Template body"), { target: { value: "export const edited = true;\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(FILE_TEMPLATES_KEY)!) as { templates: Record<string, FileTemplate> };
    expect(Object.values(stored.templates)).toEqual([
      expect.objectContaining({
        name: "Edited component",
        extension: "jsx",
        nameStyle: "asis",
        kinds: [{ id: "default", label: "Default", body: "export const edited = true;\n" }],
      }),
    ]);
    expect(fileTemplates()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Edited component" })]));
    expect(view!.state.doc.toString()).toBe(unsaved);
  });

  it.each([
    ["/p/.gitignore", ".gitignore", ""],
    ["/p/Dockerfile", "Dockerfile", ""],
  ])("keeps the name and empty extension of %s", (path, name, extension) => {
    activateDialog(path, "saved\n");
    expect(screen.getByLabelText("Name")).toHaveValue(name);
    expect(screen.getByLabelText("Extension")).toHaveValue(extension);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  });

  it("reports an empty name accessibly and Escape cancels without writing", () => {
    activateDialog();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name");
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(localStorage.getItem(FILE_TEMPLATES_KEY)).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does nothing without a file-backed active editor", () => {
    render(<SaveFileTemplateDialogHost />);
    deactivate = activate();
    const action = getAction(ACTION_ID)!;
    expect(action.enabled?.({ ctx: {} })).toBe(false);
    act(() => action.run({ ctx: {} }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    view = new EditorView({ state: EditorState.create({ doc: "class A {}" }), parent: document.body });
    _setActiveEditor({
      view,
      ctx: { doc: 1, path: "jar:///lib/A.java", language: "java", uiMode: "Java", readOnly: false, virtual: true },
    });
    expect(action.enabled?.({ ctx: {} })).toBe(false);
    act(() => action.run({ ctx: {} }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("file-template scheme storage", () => {
  it("saves to Default without switching or modifying a selected Project scheme", () => {
    useProject.setState({ project: { root: "/p", name: "p" } as unknown as ProjectInfo });
    reloadFileTemplates();
    const defaultTemplate = template("user.default", "Default template", "default\n");
    saveFileTemplate(defaultTemplate);
    setTemplateScheme("project");
    const projectKey = `${FILE_TEMPLATES_KEY}.project:/p`;
    const schemeKey = `${FILE_TEMPLATES_KEY}.scheme:/p`;
    const projectBefore = localStorage.getItem(projectKey);

    const globalTemplate = template("user.global", "Global template", "global\n");
    saveFileTemplate(globalTemplate, "default");

    expect(useFileTemplates.getState().scheme).toBe("project");
    expect(useFileTemplates.getState().templates.some((t) => t.id === globalTemplate.id)).toBe(false);
    expect(localStorage.getItem(projectKey)).toBe(projectBefore);
    expect(JSON.parse(localStorage.getItem(schemeKey)!).scheme).toBe("project");
    const stored = JSON.parse(localStorage.getItem(FILE_TEMPLATES_KEY)!) as { templates: Record<string, FileTemplate> };
    expect(stored.templates[globalTemplate.id]).toEqual(globalTemplate);

    setTemplateScheme("default");
    expect(fileTemplates()).toEqual(expect.arrayContaining([defaultTemplate, globalTemplate]));
  });
});
