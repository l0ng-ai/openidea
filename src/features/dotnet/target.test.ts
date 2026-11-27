import { describe, expect, it } from "vitest";
import { contextDotnetTarget, type DotnetTargetContext } from "./target";

const project = (path: string) => ({ path, name: path.split("/").at(-1) ?? path });
const solution = (path: string, projects: string[]) => ({ path, projects });

const ctx = (over: Partial<DotnetTargetContext> = {}): DotnetTargetContext => ({
  selected: [],
  editorFile: null,
  model: { projects: [], solutions: [] },
  ...over,
});

describe("the .NET target of the current context", () => {
  it("builds the project file selected in the Project tool window", () => {
    const c = ctx({
      selected: ["/repo/src/App/App.csproj"],
      editorFile: "/repo/other/Program.cs",
      model: {
        projects: [project("/repo/src/App/App.csproj"), project("/repo/other/Other.csproj")],
        solutions: [solution("/repo/Demo.sln", ["/repo/src/App/App.csproj"])],
      },
    });
    expect(contextDotnetTarget(c)).toBe("/repo/src/App/App.csproj");
  });

  it("builds the F# project or the solution selected in the Project tool window", () => {
    expect(contextDotnetTarget(ctx({ selected: ["/repo/App.fsproj"] }))).toBe("/repo/App.fsproj");
    expect(contextDotnetTarget(ctx({ selected: ["/repo/Demo.sln"] }))).toBe("/repo/Demo.sln");
    expect(contextDotnetTarget(ctx({ selected: ["/repo/Demo.slnx"] }))).toBe("/repo/Demo.slnx");
  });

  it("ignores a selection that is no .NET project or solution file", () => {
    const c = ctx({
      selected: ["/repo/src/App/Program.cs", "/repo/README.md"],
      editorFile: "/repo/src/App/Program.cs",
      model: {
        projects: [project("/repo/src/App/App.csproj")],
        solutions: [solution("/repo/Demo.sln", ["/repo/src/App/App.csproj"])],
      },
    });
    expect(contextDotnetTarget(c)).toBe("/repo/src/App/App.csproj");
  });

  it("builds the project of the active editor's file, the deepest one when projects nest", () => {
    const model = {
      projects: [project("/repo/src/App/App.csproj"), project("/repo/src/App.Tests/App.Tests.csproj")],
      solutions: [solution("/repo/Demo.sln", [])],
    };
    expect(contextDotnetTarget(ctx({ editorFile: "/repo/src/App/Program.cs", model: structuredClone(model) }))).toBe(
      "/repo/src/App/App.csproj",
    );
    expect(contextDotnetTarget(ctx({ editorFile: "/repo/src/App.Tests/Unit.cs", model: structuredClone(model) }))).toBe(
      "/repo/src/App.Tests/App.Tests.csproj",
    );
  });

  it("does not confuse a project directory with a longer sibling name", () => {
    const model = {
      projects: [project("/repo/src/App/App.csproj")],
      solutions: [solution("/repo/Demo.sln", [])],
    };
    expect(contextDotnetTarget(ctx({ editorFile: "/repo/src/AppOther/Program.cs", model }))).toBe("/repo/Demo.sln");
  });

  it("falls back to the first solution when the editor file matches no project", () => {
    const model = {
      projects: [project("/repo/src/App/App.csproj")],
      solutions: [solution("/repo/First.sln", ["/repo/src/App/App.csproj"]), solution("/repo/Second.sln", [])],
    };
    expect(contextDotnetTarget(ctx({ editorFile: "/repo/notes.txt", model }))).toBe("/repo/First.sln");
  });

  it("falls back to the first solution with neither a selection nor an editor file", () => {
    const model = {
      projects: [project("/repo/src/App/App.csproj")],
      solutions: [solution("/repo/Demo.sln", [])],
    };
    expect(contextDotnetTarget(ctx({ model }))).toBe("/repo/Demo.sln");
  });

  it("finds nothing without a selection, an editor file or a solution", () => {
    expect(contextDotnetTarget(ctx())).toBeNull();
    expect(contextDotnetTarget(ctx({ model: { projects: [project("/repo/App.csproj")], solutions: [] } }))).toBeNull();
  });
});
