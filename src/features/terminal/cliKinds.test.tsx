/**
 * Terminal editor tabs (#2202) in the workbench: the editor kind the terminal
 * feature registers, Move to Editor, what the editor session saves for the tabs,
 * and the Start screen of a tab restored without its session (nothing runs on its own).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { useContributions, type EditorInput } from "@/workbench/contributions";
import { initialTabsState, openTab, paneIds, type TabsState } from "@/editor/core/model/tabs";
import { parseSession, restoreTabsState, serializeSession } from "@/editor/core/model/session";
import { CLI_KIND, cliInput, useClis } from "./cli";
import { CliEditor } from "./CliEditor";
import { activate } from "./index";

const runtime = vi.hoisted(() => ({
  loaded: false,
  startCli: vi.fn(),
  disposeCli: vi.fn(),
  cliBusy: vi.fn(),
  detachTab: vi.fn(),
  useTerminals: { getState: () => ({ tabs: [] as { id: string }[], activeTab: null, sessions: {} }) },
}));
const editorService = vi.hoisted(() => ({
  openInput: vi.fn(async () => undefined),
  closeInput: vi.fn(async () => true),
}));

vi.mock("./loader", () => ({
  loadTerminalRuntime: async () => runtime,
  terminalRuntime: () => (runtime.loaded ? runtime : null),
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorService: () => editorService,
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
      expect(kind).toMatchObject({ restorable: true, keepAlive: true });
      expect(kind?.isBusy?.(cliInputOf())).toBe(false);
      expect(kind?.title?.(cliInputOf())).toBe("Claude Code");
      expect(kind?.title?.({ kind: "cli", key: "cli:r9", data: {} })).toBe("Terminal");
    } finally {
      deactivate();
    }
    expect(useContributions.getState().editorKinds.has("cli")).toBe(false);
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

  it("offers Move to Editor for a terminal tab", async () => {
    const deactivate = activate();
    try {
      await executeAction("terminal.moveToEditor", "t9");
      // An unknown tab moves nothing.
      expect(runtime.detachTab).not.toHaveBeenCalled();
      expect(editorService.openInput).not.toHaveBeenCalled();
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
});
