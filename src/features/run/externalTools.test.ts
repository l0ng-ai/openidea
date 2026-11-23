import { EditorSelection, EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { DEFAULT_EXTERNAL_TOOL } from "@/platform/workflowSettings";
import { clearProjectViewLead, setProjectViewLead } from "@/workbench/contributions";
import { externalToolConfig } from "./externalTools";

const editor = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/editor/api", () => ({ activeEditor: () => editor.current }));

// Editor on A.java, caret on line 2 with "two" selected.
function openA() {
  const doc = "one\ntwo\n";
  const state = EditorState.create({ doc, selection: EditorSelection.single(4, 7) });
  editor.current = { ctx: { path: "/p/src/A.java" }, view: { state } };
}

const tool = {
  ...DEFAULT_EXTERNAL_TOOL,
  id: "t",
  name: "Echo",
  program: "echo",
  arguments:
    "$FilePath$ $FileDir$ $FileName$ $FileNameWithoutExtension$ $FileExt$ $FileRelativePath$ " +
    "$FileDirRelativeToProjectRoot$ L$LineNumber$ C$ColumnNumber$ S$SelectedText$",
};

const argsFor = async () => (await externalToolConfig(tool))?.args;

describe("external tool macros", () => {
  beforeEach(() => {
    useProject.setState({ project: { root: "/p", name: "demo" } as never });
    setContext("editorFocus", false);
    openA();
  });
  afterEach(() => {
    clearProjectViewLead();
    editor.current = null;
    useProject.setState({ project: null });
  });

  it("uses the file selected in the Project view over the open editor (#5402)", async () => {
    setProjectViewLead({ path: "/p/lib/B.kt", dir: false });
    expect(await argsFor()).toEqual(["/p/lib/B.kt", "/p/lib", "B.kt", "B", "kt", "lib/B.kt", "lib", "L", "C", "S"]);
  });

  it("uses the editor's file and caret when the editor is the context", async () => {
    expect(await argsFor()).toEqual([
      "/p/src/A.java",
      "/p/src",
      "A.java",
      "A",
      "java",
      "src/A.java",
      "src",
      "L2",
      "C4",
      "Stwo",
    ]);
  });

  it("keeps the caret macros when the Project view selects the editor's file", async () => {
    setProjectViewLead({ path: "/p/src/A.java", dir: false });
    expect((await argsFor())?.slice(-3)).toEqual(["L2", "C4", "Stwo"]);
  });

  it("falls back to the editor for a selected directory", async () => {
    setProjectViewLead({ path: "/p/lib", dir: true });
    expect((await argsFor())?.[0]).toBe("/p/src/A.java");
  });

  it("lets the focused editor win over a stale tree selection", async () => {
    setProjectViewLead({ path: "/p/lib/B.kt", dir: false });
    setContext("editorFocus", true);
    expect((await argsFor())?.[0]).toBe("/p/src/A.java");
  });

  it("uses the tree selection with no editor open", async () => {
    editor.current = null;
    setProjectViewLead({ path: "/p/lib/B.kt", dir: false });
    expect((await argsFor())?.[0]).toBe("/p/lib/B.kt");
  });
});
