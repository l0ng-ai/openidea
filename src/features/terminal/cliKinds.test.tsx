/**
 * Terminal editor tabs (#2202) in the workbench: the editor kind the terminal
 * feature registers, Move to Editor, what the editor session saves for the tabs,
 * and the Start screen of a tab restored without its session (nothing runs on its own).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import {
  EDITOR_TAB_MIME,
  dropOnEditor,
  editorDropAllowsSplit,
  menuGroupItems,
  useContributions,
  type EditorInput,
} from "@/workbench/contributions";
import { initialTabsState, openTab, paneIds, type TabsState } from "@/editor/core/model/tabs";
import { parseSession, restoreTabsState, serializeSession } from "@/editor/core/model/session";
import { CLI_KIND, TERMINAL_TAB_MIME, cliInput, useClis } from "./cli";
import { CliEditor } from "./CliEditor";
import { activate } from "./index";

const runtime = vi.hoisted(() => ({
  loaded: false,
  activeSession: vi.fn(),
  newTab: vi.fn(),
  nextTabName: vi.fn((existing: readonly string[], base = "Local") => (existing.includes(base) ? `${base} (2)` : base)),
  startCli: vi.fn(),
  startDirectory: vi.fn((root: string) => root),
  disposeCli: vi.fn(),
  cliBusy: vi.fn(),
  cliSession: vi.fn(),
  detachTab: vi.fn(),
  useTerminals: { getState: () => ({ tabs: [] as { id: string; name: string }[], activeTab: null, sessions: {} }) },
}));
const editorService = vi.hoisted(() => ({
  activeInput: vi.fn<() => EditorInput | null>(() => null),
  openInput: vi.fn(async () => undefined),
  closeInput: vi.fn(async () => true),
  openTabs: vi.fn<() => { input: EditorInput; title: string }[]>(() => []),
  tabInput: vi.fn<(paneId: string, tabId: string) => EditorInput | null>(() => null),
}));
const toolWindows = vi.hoisted(() => ({ hide: vi.fn(), show: vi.fn() }));

vi.mock("./loader", () => ({
  loadTerminalRuntime: async () => runtime,
  terminalRuntime: () => (runtime.loaded ? runtime : null),
}));
vi.mock("./cliSessions", () => ({
  cliSession: (key: string) => runtime.cliSession(key),
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorService: () => editorService,
  maybeEditorService: () => editorService,
  toolWindowService: () => toolWindows,
}));

const cliInputOf = (key = "cli:r1-x"): EditorInput => ({
  kind: CLI_KIND,
  key,
  data: { name: "Claude Code", command: "claude" },
});

/** Opens `inputs` as tabs in a fresh state. */
const withTabs = (...inputs: EditorInput[]): TabsState => {
  let s = initialTabsState();
  const paneId = paneIds(s)[0]!;
  for (const i of inputs) {
    const r = openTab(s, paneId, i);
    s = r.state;
    void r.tabId;
  }
  return s;
};

beforeEach(() => {
  useProject.setState({ project: { root: "/repo" } as never });
  setContext("projectOpen", true);
});
afterEach(() => {
  vi.clearAllMocks();
  cleanup();
  useProject.setState({ project: null, settings: null });
  useClis.setState({ sessions: {} });
});

describe("terminal editor kind", () => {
  it("registers the session tab (kept alive, restorable, busy-aware)", () => {
    const deactivate = activate();
    try {
      const kind = useContributions.getState().editorKinds.get("cli");
      expect(kind).toMatchObject({ restorable: true, keepAlive: true, singleton: true });
      expect(editorDropAllowsSplit(TERMINAL_TAB_MIME)).toBe(true);
      expect(dropOnEditor({ type: TERMINAL_TAB_MIME, payload: "t9" }, { paneId: "p1", zone: "right" })).toBe(true);
      expect(kind?.isBusy?.(cliInputOf())).toBe(false);
      expect(kind?.title?.(cliInputOf())).toBe("Claude Code");
      expect(kind?.title?.({ kind: "cli", key: "cli:r9", data: {} })).toBe("Terminal");
    } finally {
      deactivate();
    }
    expect(useContributions.getState().editorKinds.has("cli")).toBe(false);
    expect(editorDropAllowsSplit(TERMINAL_TAB_MIME)).toBe(false);
  });

  it("asks the runtime about busy tabs and ends their sessions on close", () => {
    const deactivate = activate();
    try {
      runtime.loaded = true;
      runtime.cliBusy.mockReturnValue(true);
      const kind = useContributions.getState().editorKinds.get("cli")!;
      expect(kind.isBusy?.(cliInputOf())).toBe(true);
      expect(runtime.cliBusy).toHaveBeenCalledWith("cli:r1-x");
      kind.onClose?.(cliInputOf());
      expect(runtime.disposeCli).toHaveBeenCalledWith("cli:r1-x");
    } finally {
      runtime.loaded = false;
      deactivate();
    }
  });

  it("saves the tabs with the session and restores them unstarted", () => {
    const deactivate = activate();
    try {
      const s = withTabs(cliInputOf());
      const restored = parseSession(
        JSON.parse(
          JSON.stringify(
            serializeSession(s, {}, (i) => !!useContributions.getState().editorKinds.get(i.kind)?.restorable),
          ),
        ),
      );
      expect(restored).not.toBeNull();
      const tabs = restoreTabsState(restored!, (p) => `file:${p}`);
      const open = Object.values(tabs.panes).flatMap((p) => p.tabs);
      expect(open.map((t) => t.input.kind)).toEqual(["cli"]);
      expect(open[0]!.input).toEqual(cliInputOf());
      // A restored tab has no session: it must not run anything on its own.
      expect(runtime.startCli).not.toHaveBeenCalled();
      expect(useClis.getState().sessions).toEqual({});
    } finally {
      deactivate();
    }
  });

  it("offers Move to Editor for a terminal tab and Move to Terminal for a cli editor tab", async () => {
    const deactivate = activate();
    try {
      await executeAction("terminal.moveToEditor", "t9");
      // An unknown tab moves nothing.
      expect(runtime.detachTab).not.toHaveBeenCalled();
      expect(editorService.openInput).not.toHaveBeenCalled();

      const cli = cliInputOf("cli:r3-z");
      expect(menuGroupItems("editorTab", { paths: [], input: cli })).toContainEqual({
        kind: "action",
        action: "terminal.moveToToolWindow",
        arg: "cli:r3-z",
      });
      expect(menuGroupItems("editorTab", { paths: ["/repo/a.ts"] })).toEqual([]);

      const tw = useContributions.getState().toolWindows.get("terminal")!;
      editorService.tabInput.mockImplementation((p, t) =>
        p === "p1" && t === "tab1" ? cli : { kind: "file", key: "file:/repo/a.ts", path: "/repo/a.ts" },
      );
      const valid = { type: EDITOR_TAB_MIME, payload: JSON.stringify({ paneId: "p1", tabId: "tab1" }) };
      const file = { type: EDITOR_TAB_MIME, payload: JSON.stringify({ paneId: "p1", tabId: "tab2" }) };
      expect(tw.onStripeDrop?.accepts(EDITOR_TAB_MIME, valid)).toBe(true);
      expect(tw.onStripeDrop?.accepts(EDITOR_TAB_MIME, file)).toBe(false);
    } finally {
      deactivate();
    }
  });
});

describe("restored terminal editor tab", () => {
  it("shows Start and runs the command only when asked", async () => {
    const deactivate = activate();
    try {
      runtime.loaded = true;
      render(<CliEditor input={cliInputOf("cli:r2-y")} />);
      expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
      expect(screen.getByText("claude")).toBeInTheDocument();
      expect(runtime.startCli).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
      expect(runtime.startCli).toHaveBeenCalledExactlyOnceWith("cli:r2-y", "/repo", "claude", "/repo");
      // Once the session exists the tab is the xterm pane, not the Start screen.
      act(() => {
        useClis.setState({ sessions: { "cli:r2-y": { status: "running" } as never } });
      });
      expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    } finally {
      runtime.loaded = false;
      deactivate();
    }
  });

  it("mints keys that never repeat, so a restored tab never meets a live session", () => {
    expect(cliInput("A", "a").key).not.toBe(cliInput("A", "a").key);
  });

  it("hands focus to xterm when the editor wrapper is already focused on mount", () => {
    const session = { attach: vi.fn(), detach: vi.fn(), focus: vi.fn() };
    runtime.cliSession.mockReturnValue(session);
    useClis.setState({ sessions: { "cli:r3-live": { status: "running" } as never } });
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-editor-focus", "");
    wrapper.tabIndex = -1;
    document.body.appendChild(wrapper);
    wrapper.focus();
    try {
      render(<CliEditor input={cliInputOf("cli:r3-live")} />, { container: wrapper });
      expect(session.attach).toHaveBeenCalledOnce();
      expect(session.focus).toHaveBeenCalledOnce();
    } finally {
      wrapper.remove();
    }
  });
});

describe("New Terminal Tab shortcut routing", () => {
  it("routes shared ⌘T to Terminal in terminalFocus and to Editor outside Terminal and popups", async () => {
    const initialKeymap = useKeymap.getState();
    const deactivate = activate();
    const uninstall = installKeyboardDispatcher(window);
    useKeymap.setState({
      preset: "intellij-macos",
      overrides: { "terminal.newInEditor": ["Meta+T"] },
    });
    const pressCmdT = () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true, cancelable: true }));
    try {
      setContext("terminalFocus", true);
      setContext("activeToolWindow", "terminal");
      setContext("editorAreaFocus", false);
      setContext("popupOpen", false);
      pressCmdT();
      await vi.waitFor(() => expect(runtime.newTab).toHaveBeenCalledOnce());
      expect(editorService.openInput).not.toHaveBeenCalled();

      // Terminal tool window chrome (header / find bar) must not open an editor terminal.
      vi.clearAllMocks();
      setContext("terminalFocus", false);
      setContext("activeToolWindow", "terminal");
      pressCmdT();
      await Promise.resolve();
      expect(runtime.newTab).not.toHaveBeenCalled();
      expect(editorService.openInput).not.toHaveBeenCalled();

      // Editor area opens an editor terminal tab.
      vi.clearAllMocks();
      setContext("activeToolWindow", "");
      setContext("editorAreaFocus", true);
      pressCmdT();
      await vi.waitFor(() => expect(editorService.openInput).toHaveBeenCalledOnce());
      expect(runtime.newTab).not.toHaveBeenCalled();

      // Other tool windows (e.g. Agents, Project) also open an editor terminal tab.
      vi.clearAllMocks();
      setContext("editorAreaFocus", false);
      setContext("activeToolWindow", "agents");
      pressCmdT();
      await vi.waitFor(() => expect(editorService.openInput).toHaveBeenCalledOnce());
      expect(runtime.newTab).not.toHaveBeenCalled();

      // Popups and dialogs suppress the shortcut.
      vi.clearAllMocks();
      setContext("popupOpen", true);
      pressCmdT();
      await Promise.resolve();
      expect(runtime.newTab).not.toHaveBeenCalled();
      expect(editorService.openInput).not.toHaveBeenCalled();
    } finally {
      clearContext("terminalFocus");
      clearContext("activeToolWindow");
      clearContext("editorAreaFocus");
      clearContext("popupOpen");
      useKeymap.setState(initialKeymap);
      uninstall();
      deactivate();
    }
  });
});
