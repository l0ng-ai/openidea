import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AgentEntry, AgentTask } from "@/bindings";
import { _addEditor, _removeEditor, type EditorDocContext } from "@/editor/api";
import { fontZoom as cmFontZoom, resetAllEditorsFontZoom } from "@/editor/core/cm/prefs";
import type { EditorSlot } from "@/editor/core/model/slot";
import { executeAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { useProject } from "@/platform/project";
import { EditorShownProvider, EditorTabIdProvider } from "@/workbench/contributions";
import { HomeEditor } from "./HomeEditor";
import { SessionEditor } from "./SessionEditor";
import {
  clearAgentTabFontZoom,
  clearAgentTaskFontZoom,
  resetAllAgentFontZoom,
  stepAgentSurfaceFontZoom,
  useAgentFontZoom,
} from "./fontZoom";
import { SESSION_KIND, sessionKey } from "./model";
import { disconnect, useAgents } from "./store";
import styles from "./Session.module.css";

let activeSlot: Partial<EditorSlot> | null = null;
const imageReads = new Map<string, string>();

vi.mock("@/editor/core/controller", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorController: () => ({
    get activeSlot() {
      return activeSlot;
    },
  }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    fsProbe: async () => ({
      status: "ok",
      data: { size: 1, binary: false, tooLarge: false },
    }),
    fsReadImage: async (path: string) => {
      const url = imageReads.get(path);
      if (url) return { status: "ok", data: url };
      return { status: "error", error: { kind: "notFound", message: path } };
    },
    agentEntries: async () => ({ status: "ok", data: [] as AgentEntry[] }),
    agentChanges: async () => ({ status: "ok", data: [] }),
    agentGroupedChanges: async () => ({ status: "ok", data: { uncommitted: [], commits: [] } }),
    agentProviders: async () => ({ status: "ok", data: [] }),
    vcsBranchInfo: async () => ({ status: "ok", data: { head: "main" } }),
    vcsBranches: async () => ({ status: "ok", data: [] }),
  },
}));

const { registerEditorActions } = await import("@/editor/core/actions");
const { useTabs } = await import("@/editor/core/controller");

const makeTask = (id: string): AgentTask => ({
  id,
  title: id,
  provider: "copilot",
  status: "ready",
  isolation: "local",
  model: null,
  cwd: "/project",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
});

describe("Agent chat font size zoom", () => {
  const disposers: Array<() => void> = [];
  const views: EditorView[] = [];

  beforeEach(() => {
    resetAllEditorsFontZoom();
    resetAllAgentFontZoom();
    imageReads.clear();
    disposers.push(registerEditorActions());
    useContextKeys.setState({ projectOpen: true, textEditorActive: false, editorFocus: true, popupOpen: false });
    useProject.setState({
      project: { name: "openidea", root: "/project", isGit: true, workspace: null } as never,
      settings: null,
    });
    const t1 = makeTask("t1");
    const t2 = makeTask("t2");
    useAgents.setState({
      loaded: true,
      tasks: new Map([
        [t1.id, t1],
        [t2.id, t2],
      ]),
      entries: new Map([
        [t1.id, [{ type: "agent", text: "Hello `world`" }]],
        [t2.id, [{ type: "agent", text: "Second task" }]],
      ]),
    });
  });

  afterEach(() => {
    cleanup();
    for (const view of views.splice(0)) view.destroy();
    for (const dispose of disposers.splice(0).reverse()) dispose();
    activeSlot = null;
    disconnect();
    resetAllAgentFontZoom();
    useProject.setState({ project: null, settings: null });
    useContextKeys.setState({}, true);
  });

  it("scales only the focused Agent chat tab with ⌘=/⌘-/⌘0, clamped to -6..36, leaving other chat tabs untouched", async () => {
    const { container } = render(
      <div>
        <div data-pane-id="left">
          <div data-editor-focus="" tabIndex={-1}>
            <EditorTabIdProvider value="tab-1">
              <EditorShownProvider value={true}>
                <SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("t1"), data: { task: "t1" } }} />
              </EditorShownProvider>
            </EditorTabIdProvider>
          </div>
          <EditorTabIdProvider value="tab-kept">
            <EditorShownProvider value={false}>
              <SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("t2"), data: { task: "t2" } }} />
            </EditorShownProvider>
          </EditorTabIdProvider>
        </div>
        <div data-pane-id="right">
          <div data-editor-focus="" tabIndex={-1}>
            <EditorTabIdProvider value="tab-2">
              <EditorShownProvider value={true}>
                <SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("t1"), data: { task: "t1" } }} />
              </EditorShownProvider>
            </EditorTabIdProvider>
          </div>
        </div>
        <HomeEditor docked />
      </div>,
    );
    act(() => useTabs.setState((s) => ({ ...s, activePane: "left" })));

    const sessions = container.querySelectorAll<HTMLElement>(`.${styles.session}`);
    const leftSession = sessions[0]!;
    const keptSession = sessions[1]!;
    const rightSession = sessions[2]!;
    const home = container.querySelector<HTMLElement>('[class*="home"]')!;

    expect(leftSession.style.getPropertyValue("--agent-font-zoom")).toBe("0px");
    expect(rightSession.style.getPropertyValue("--agent-font-zoom")).toBe("0px");
    expect(home.style.getPropertyValue("--agent-font-zoom")).toBe("0px");

    // Works when the composer's CodeMirror input in tab-1 has focus — only tab-1 changes.
    leftSession.querySelector<HTMLElement>(".cm-content")!.focus();
    await act(() => executeAction("editor.increaseFontSize"));
    await act(() => executeAction("editor.increaseFontSize"));
    expect(leftSession.style.getPropertyValue("--agent-font-zoom")).toBe("2px");
    expect(leftSession.style.getPropertyValue("--markdown-zoom-scale")).toBe("1.1538");
    expect(keptSession.style.getPropertyValue("--agent-font-zoom")).toBe("0px");
    expect(rightSession.style.getPropertyValue("--agent-font-zoom")).toBe("0px");
    expect(home.style.getPropertyValue("--agent-font-zoom")).toBe("0px");

    // Focusing right split tab-2 (even showing the same task t1) zooms only tab-2.
    rightSession.querySelector<HTMLElement>(".cm-content")!.focus();
    await act(() => executeAction("editor.decreaseFontSize"));
    expect(rightSession.style.getPropertyValue("--agent-font-zoom")).toBe("-1px");
    expect(rightSession.style.getPropertyValue("--markdown-zoom-scale")).toBe("0.9231");
    expect(leftSession.style.getPropertyValue("--agent-font-zoom")).toBe("2px");

    // ⌘0 while focused in tab-2 resets only tab-2, keeping tab-1 at +2px.
    await act(() => executeAction("editor.resetFontSize"));
    expect(rightSession.style.getPropertyValue("--agent-font-zoom")).toBe("0px");
    expect(leftSession.style.getPropertyValue("--agent-font-zoom")).toBe("2px");

    // Works when the active pane's KindEditor [data-editor-focus] wrapper or body has focus.
    const leftWrapper = container.querySelector<HTMLElement>('[data-pane-id="left"] [data-editor-focus]')!;
    leftWrapper.focus();
    await act(() => executeAction("editor.increaseFontSize"));
    expect(leftSession.style.getPropertyValue("--agent-font-zoom")).toBe("3px");

    document.body.focus();
    await act(() => executeAction("editor.decreaseFontSize"));
    expect(leftSession.style.getPropertyValue("--agent-font-zoom")).toBe("2px");

    // Clamped to -6..36.
    act(() => stepAgentSurfaceFontZoom("tab:tab-1", 100));
    expect(useAgentFontZoom.getState().bySurface["tab:tab-1"]).toBe(36);
    await act(() => executeAction("editor.increaseFontSize"));
    expect(useAgentFontZoom.getState().bySurface["tab:tab-1"]).toBe(36);

    act(() => stepAgentSurfaceFontZoom("tab:tab-1", -100));
    expect(useAgentFontZoom.getState().bySurface["tab:tab-1"]).toBe(-6);
    await act(() => executeAction("editor.decreaseFontSize"));
    expect(useAgentFontZoom.getState().bySurface["tab:tab-1"]).toBe(-6);

    // ⌘0 on the active pane resets tab-1.
    await act(() => executeAction("editor.resetFontSize"));
    expect(leftSession.style.getPropertyValue("--agent-font-zoom")).toBe("0px");
    expect(leftSession.style.getPropertyValue("--markdown-zoom-scale")).toBe("1");
  });

  it("isolates docked Agent chat and code editor resets from each other", async () => {
    const ctx: EditorDocContext = {
      doc: 1,
      path: "/project/a.ts",
      language: "typescript",
      uiMode: null,
      readOnly: false,
    };
    const view = new EditorView({ state: EditorState.create({ doc: "const x = 1;", extensions: [cmFontZoom] }) });
    document.body.appendChild(view.dom);
    const handle = { view, ctx };
    _addEditor(handle);
    disposers.push(() => {
      _removeEditor(handle);
      view.dom.remove();
    });
    views.push(view);
    activeSlot = { view, disposed: false };

    const { container } = render(
      <SessionEditor docked input={{ kind: SESSION_KIND, key: sessionKey("t1"), data: { task: "t1" } }} />,
    );
    const stream = container.querySelector<HTMLElement>(`.${styles.stream}`)!;

    // Zoom code editor first (+2), then zoom docked chat (+1).
    view.contentDOM.focus();
    await act(() => executeAction("editor.increaseFontSize"));
    await act(() => executeAction("editor.increaseFontSize"));
    expect(view.state.field(cmFontZoom)).toBe(2);

    stream.focus();
    await act(() => executeAction("editor.increaseFontSize"));
    expect(useAgentFontZoom.getState().bySurface["docked:agent:t1"]).toBe(1);
    expect(view.state.field(cmFontZoom)).toBe(2);

    // Resetting in code editor leaves docked chat at +1.
    view.contentDOM.focus();
    await act(() => executeAction("editor.resetFontSize"));
    expect(view.state.field(cmFontZoom)).toBe(0);
    expect(useAgentFontZoom.getState().bySurface["docked:agent:t1"]).toBe(1);

    // Zoom code editor again (+1); resetting in docked chat leaves code editor at +1.
    await act(() => executeAction("editor.increaseFontSize"));
    expect(view.state.field(cmFontZoom)).toBe(1);

    stream.focus();
    await act(() => executeAction("editor.resetFontSize"));
    expect(useAgentFontZoom.getState().bySurface["docked:agent:t1"]).toBeUndefined();
    expect(view.state.field(cmFontZoom)).toBe(1);
  });

  it("zooms with ⌘/Ctrl+wheel only on the hovered chat tab when editor.general.wheelZoom is enabled", () => {
    const { container } = render(
      <div>
        <EditorTabIdProvider value="tab-1">
          <SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("t1"), data: { task: "t1" } }} />
        </EditorTabIdProvider>
        <EditorTabIdProvider value="tab-2">
          <SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("t2"), data: { task: "t2" } }} />
        </EditorTabIdProvider>
      </div>,
    );
    const streams = container.querySelectorAll<HTMLElement>(`.${styles.stream}`);
    const stream1 = streams[0]!;

    const offEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true, metaKey: true, deltaY: -100 });
    act(() => {
      stream1.dispatchEvent(offEvent);
    });
    expect(offEvent.defaultPrevented).toBe(false);
    expect(useAgentFontZoom.getState().bySurface).toEqual({});

    act(() =>
      useProject.setState((s) => ({
        ...s,
        settings: { editor: { general: { wheelZoom: true } } } as never,
      })),
    );

    const up = new WheelEvent("wheel", { bubbles: true, cancelable: true, metaKey: true, deltaY: -100 });
    act(() => {
      stream1.dispatchEvent(up);
    });
    expect(up.defaultPrevented).toBe(true);
    expect(useAgentFontZoom.getState().bySurface).toEqual({ "tab:tab-1": 1 });

    const down = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 100 });
    act(() => {
      stream1.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(useAgentFontZoom.getState().bySurface).toEqual({});

    const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    act(() => {
      stream1.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
  });

  it("sizes SVG and raster images in replies so they scale with --markdown-zoom-scale", async () => {
    const svgUrl = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"></svg>')}`;
    const pngUrl = "data:image/png;base64,iVBORw0KGgo=";
    imageReads.set("/project/diagram.svg", svgUrl);
    imageReads.set("/project/shot.png", pngUrl);

    act(() =>
      useAgents.setState((s) => ({
        ...s,
        entries: new Map([["t1", [{ type: "agent", text: "![Diagram](diagram.svg)\n\n![Shot](shot.png)" }]]]),
      })),
    );

    const { container } = render(
      <EditorShownProvider value={true}>
        <SessionEditor input={{ kind: SESSION_KIND, key: sessionKey("t1"), data: { task: "t1" } }} />
      </EditorShownProvider>,
    );

    await vi.waitFor(() => {
      const diag = container.querySelector<HTMLImageElement>('img[alt="Diagram"]');
      expect(diag?.getAttribute("src")).toBe(svgUrl);
    });

    const diag = container.querySelector<HTMLImageElement>('img[alt="Diagram"]')!;
    expect(diag.hasAttribute("data-natural-width")).toBe(true);
    expect(diag.style.getPropertyValue("--image-width")).toBe("320px");

    const shot = container.querySelector<HTMLImageElement>('img[alt="Shot"]')!;
    Object.defineProperty(shot, "naturalWidth", { value: 640, configurable: true });
    Object.defineProperty(shot, "naturalHeight", { value: 360, configurable: true });
    act(() => {
      shot.dispatchEvent(new Event("load"));
    });
    expect(shot.hasAttribute("data-natural-width")).toBe(true);
    expect(shot.style.getPropertyValue("--image-width")).toBe("640px");
  });

  it("prunes bySurface entries when a tab closes or a task is removed", () => {
    stepAgentSurfaceFontZoom("tab:tab-a", 4);
    stepAgentSurfaceFontZoom("tab:tab-b", -2);
    stepAgentSurfaceFontZoom("docked:agent:t1", 3);
    stepAgentSurfaceFontZoom("agent:t1", 2);
    expect(useAgentFontZoom.getState().bySurface).toEqual({
      "tab:tab-a": 4,
      "tab:tab-b": -2,
      "docked:agent:t1": 3,
      "agent:t1": 2,
    });

    clearAgentTabFontZoom("tab-a");
    expect(useAgentFontZoom.getState().bySurface).toEqual({
      "tab:tab-b": -2,
      "docked:agent:t1": 3,
      "agent:t1": 2,
    });

    clearAgentTaskFontZoom("agent:t1");
    expect(useAgentFontZoom.getState().bySurface).toEqual({
      "tab:tab-b": -2,
    });
  });
});
