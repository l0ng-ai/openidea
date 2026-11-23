import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import * as contributions from "@/workbench/contributions";
import type { MenuItem } from "@/ui";
import { agentReferences, copyAgentReferenceActions, registerCopyAgentReference } from "./copyReference";
import { useAgents } from "./store";

const writeText = vi.fn(async (_text: string) => undefined);
const hint = vi.fn();
const notify = vi.fn();
const disposers: Array<() => void> = [];

type Item = Extract<MenuItem, { kind?: "item" }>;
const items = (ctx: { paths: string[]; dirs?: boolean[]; line?: number; endLine?: number }) =>
  contributions
    .menuGroupItems("copyPath", ctx)
    .filter((i): i is Item => i.kind !== "separator" && "run" in i && i.id === "agents.copyAgentReference");
const preview = (ctx: { paths: string[]; dirs?: boolean[]; line?: number; endLine?: number }) => items(ctx)[0]?.preview;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: navigator.userAgent });
  contributions.provideNotificationService({ notify });
  vi.spyOn(contributions, "editorService").mockReturnValue({} as contributions.EditorService);
  useProject.setState({ project: { root: "/w/api", workspace: { projects: ["/w/api", "/w/web"] } } as never });
  useAgents.setState({ draft: { ...useAgents.getState().draft, projectRoot: "/w/api" } });
  disposers.push(
    registerActions(copyAgentReferenceActions),
    registerCopyAgentReference(),
    registerAction({ id: "editor.showHint", title: "Hint", run: ({ arg }) => hint(arg) }),
  );
});

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  useProject.setState({ project: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Copy Path/Reference… › Agent Reference", () => {
  it("copies the file's `@` reference from the project root", async () => {
    const ctx = { paths: ["/w/api/internal/server.go"] };
    expect(items(ctx)[0]).toMatchObject({
      id: "agents.copyAgentReference",
      label: "Agent Reference",
      preview: "@internal/server.go",
    });
    items(ctx)[0]!.run!();
    await vi.waitFor(() => expect(hint).toHaveBeenCalledWith({ text: "Copied @internal/server.go" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("@internal/server.go");
  });

  it("follows an editor selection with its 1-based line range", async () => {
    expect(preview({ paths: ["/w/api/internal/server.go"], line: 11, endLine: 17 })).toBe("@internal/server.go:12-18");
    expect(preview({ paths: ["/w/api/a.go"], line: 4 })).toBe("@a.go:5");
    const ctx = { paths: ["/w/api/a.go"], line: 1, endLine: 3 };
    items(ctx)[0]!.run!();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("@a.go:2-4"));
  });

  it("keeps the slash of a folder and lists several paths space-separated", () => {
    expect(preview({ paths: ["/w/api/src"], dirs: [true] })).toBe("@src/");
    expect(preview({ paths: ["/w/api/main.go", "/w/web/src/app.ts"] })).toBe("@main.go @web/src/app.ts");
  });

  it("names another workspace project's files after that project", () => {
    expect(agentReferences([{ path: "/w/web/src/app.ts" }])).toBe("@web/src/app.ts");
  });

  it("qualifies paths from the primary project when the composer works in another workspace member", () => {
    useAgents.setState(({ draft }) => ({ draft: { ...draft, projectRoot: "/w/web" } }));
    expect(preview({ paths: ["/w/api/main.go", "/w/web/src/app.ts"] })).toBe("@api/main.go @src/app.ts");
  });

  it("omits virtual documents from the copy chooser", () => {
    expect(items({ paths: ["untitled:Untitled-1"], line: 0 })).toEqual([]);
    expect(agentReferences([{ path: "jdt://contents/java.jar/Main.class" }])).toBeNull();
  });

  it("points outside the projects with the path as written", () => {
    expect(agentReferences([{ path: "/tmp/notes.md" }])).toBe("@/tmp/notes.md");
  });

  it("offers nothing without a target", () => {
    expect(items({ paths: [] })).toEqual([]);
  });

  it("reports a clipboard it cannot write to", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    items({ paths: ["/w/api/a.go"] })[0]!.run!();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error", title: "Cannot access the clipboard", body: "denied" }),
      ),
    );
    expect(hint).not.toHaveBeenCalled();
  });
});
