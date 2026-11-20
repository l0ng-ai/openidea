import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { sendPaths, sendSelection } from "./references";
import { HOME, composerDraft, useAgents } from "./store";
import { installTaskWindowRouting } from "./taskWindowRouting";
import type { ComposerDraft } from "./composerModel";
import { diagnoseTestFailure } from "./testFailure";

const mocks = vi.hoisted(() => ({ notify: vi.fn(), editor: null as unknown }));
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  activeEditor: () => mocks.editor,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput: vi.fn(), openTabs: () => [], activePath: () => null }),
  notifications: () => ({ notify: mocks.notify }),
}));

const BACK = "/w/backend";
const FRONT = "/w/frontend";
const NOTICE = "Only files of this window's projects can be referenced";

const task = (cwd: string, projectRoot: string, isolation: AgentTask["isolation"]) =>
  ({ id: "t", cwd, projectRoot, isolation, title: "t", status: "ready" }) as AgentTask;

function setup(opts: { members?: string[]; homeRoot?: string; task?: AgentTask }) {
  useProject.setState({
    project: {
      root: BACK,
      trusted: true,
      workspace: opts.members ? { projects: opts.members } : null,
    } as unknown as ProjectInfo,
  });
  useAgents.setState({
    tasks: new Map(opts.task ? [["t", opts.task]] : []),
    composers: new Map(),
    lastComposer: opts.task ? "t" : HOME,
    sessionLocation: "editor",
    draft: { provider: "codex", config: {}, isolation: "local", base: null, projectRoot: opts.homeRoot ?? null },
  });
}

const sent = (key = HOME) => {
  const { text, files } = composerDraft(key);
  return { text: text.trim(), files: files.map((f) => [f.rel, f.path]) };
};

beforeEach(() => {
  mocks.notify.mockReset();
  mocks.editor = null;
});

describe("Send to Agent from the Project view", () => {
  it("appends references and failed-test context to the draft being edited in another window", () => {
    setup({ task: task(BACK, BACK, "local") });
    useAgents.setState({ composers: new Map([["t", { text: "Stale parent draft", files: [], images: [] }]]) });
    let remote: ComposerDraft = { text: "Typed in the child", files: [], images: [] };
    const update = vi.fn((key: string, patch: Partial<ComposerDraft>) => {
      if (key !== "t") return false;
      remote = { ...remote, ...patch };
      return true;
    });
    const stop = installTaskWindowRouting(() => true, undefined, {
      read: (key) => (key === "t" ? remote : undefined),
      update,
    });
    try {
      expect(sendPaths([`${BACK}/pom.xml`])).toBe(true);
      expect(remote.text).toBe("Typed in the child @pom.xml ");
      expect(remote.files).toEqual([{ path: `${BACK}/pom.xml`, rel: "pom.xml" }]);
      diagnoseTestFailure({ name: "example", output: ["Expected success"] });
      expect(remote.text).toContain("Typed in the child @pom.xml\n\nThe test example failed.");
      expect(update).toHaveBeenCalledTimes(2);
      expect(useAgents.getState().composers.get("t")?.text).toBe("Stale parent draft");
    } finally {
      stop();
    }
  });

  it("single project: files and folders as before", () => {
    setup({});
    expect(sendPaths([`${BACK}/pom.xml`, `${BACK}/src/`])).toBe(true);
    expect(sent()).toEqual({
      text: "@pom.xml @src/",
      files: [
        ["pom.xml", `${BACK}/pom.xml`],
        ["src/", `${BACK}/src`],
      ],
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("a file and folder of a non-primary project, named by that project (#4438)", () => {
    setup({ members: [BACK, FRONT], homeRoot: BACK });
    expect(sendPaths([`${FRONT}/package.json`, `${FRONT}/src/`])).toBe(true);
    expect(sent()).toEqual({
      text: "@frontend/package.json @frontend/src/",
      files: [
        ["frontend/package.json", `${FRONT}/package.json`],
        ["frontend/src/", `${FRONT}/src`],
      ],
    });
  });

  it("a selection across both projects keeps every file", () => {
    setup({ members: [BACK, FRONT], homeRoot: BACK });
    sendPaths([`${BACK}/pom.xml`, `${FRONT}/package.json`]);
    expect(sent().text).toBe("@pom.xml @frontend/package.json");
  });

  it("the New Task page's picked project is the one files are relative to", () => {
    setup({ members: [BACK, FRONT], homeRoot: FRONT });
    sendPaths([`${FRONT}/package.json`, `${BACK}/pom.xml`]);
    expect(sent().text).toBe("@package.json @backend/pom.xml");
  });

  it("a worktree task maps its own project into the worktree, not another project", () => {
    setup({ members: [BACK, FRONT], task: task("/wt/t", BACK, "worktree") });
    sendPaths([`${BACK}/pom.xml`, `${FRONT}/package.json`]);
    expect(sent("t").files).toEqual([
      ["pom.xml", "/wt/t/pom.xml"],
      ["frontend/package.json", `${FRONT}/package.json`],
    ]);
  });

  it("a path outside every project shows the notice instead of doing nothing", () => {
    setup({ members: [BACK, FRONT], homeRoot: BACK });
    expect(sendPaths(["/etc/hosts"])).toBe(false);
    expect(sent().files).toEqual([]);
    expect(mocks.notify).toHaveBeenCalledWith({ level: "info", title: NOTICE });

    mocks.notify.mockReset();
    expect(sendPaths(["/etc/hosts", `${FRONT}/package.json`])).toBe(true);
    expect(sent().text).toBe("@frontend/package.json");
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
});

describe("Send to Agent from the editor", () => {
  const openEditor = (path: string, from = 0, to = 0) => {
    const state = EditorState.create({ doc: "a\nb\nc\n", selection: EditorSelection.single(from, to) });
    mocks.editor = { ctx: { path }, view: { state } };
  };

  it("a non-primary project's file, with the selected lines", () => {
    setup({ members: [BACK, FRONT], homeRoot: BACK });
    openEditor(`${FRONT}/src/App.vue`, 2, 6);
    expect(sendSelection()).toBe(true);
    expect(sent()).toEqual({
      text: "@frontend/src/App.vue:2-3",
      files: [["frontend/src/App.vue", `${FRONT}/src/App.vue`]],
    });
  });

  it("the whole file without a selection; a file outside the projects shows the notice", () => {
    setup({ members: [BACK, FRONT], homeRoot: BACK });
    openEditor(`${BACK}/pom.xml`);
    sendSelection();
    expect(sent().text).toBe("@pom.xml");
    openEditor("/tmp/scratch.txt");
    expect(sendSelection()).toBe(false);
    expect(mocks.notify).toHaveBeenCalledWith({ level: "info", title: NOTICE });
  });
});
