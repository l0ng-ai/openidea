/**
 * CLI editor tabs (#2202) in the workbench: the editor kinds the terminal
 * feature registers, what the editor session saves for them, and the Start
 * screen of a tab restored without its session (a command never runs on its own).
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

/** Opens both a CLI tab and the launcher tab in a fresh state. */
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

describe("CLI editor kinds", () => {
  it("registers the session tab (kept alive, restorable, busy-aware) and the transient launcher", () => {
    const deactivate = activate();
    try {
      const kind = useContributions.getState().editorKinds.get("cli");
      expect(kind).toMatchObject({ restorable: true, keepAlive: true });
      expect(kind?.isBusy?.(cliInputOf())).toBe(false);
      expect(kind?.title?.(cliInputOf())).toBe("Claude Code");
      const launcher = useContributions.getState().editorKinds.get("cli.launcher");
      expect(launcher?.title?.({ kind: "cli.launcher", key: "cli:launcher" })).toBe("New CLI");
      expect(launcher?.restorable).toBeFalsy();
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

  it("saves CLI tabs with the session (never the launcher) and restores them unstarted", () => {
    const deactivate = activate();
    try {
      const s = withTabs(cliInputOf(), { kind: "cli.launcher", key: "cli:launcher" });
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

  it("opens the launcher from the cli.new action", async () => {
    const deactivate = activate();
    try {
      await executeAction("cli.new");
      expect(editorService.openInput).toHaveBeenCalledExactlyOnceWith(
        { kind: "cli.launcher", key: "cli:launcher", data: {} },
        { focus: true },
      );
    } finally {
      deactivate();
    }
  });
});

describe("restored CLI tab", () => {
  it("shows Start and runs the command only when asked", async () => {
    const deactivate = activate();
    try {
      runtime.loaded = true;
      render(<CliEditor input={cliInputOf("cli:r2-y")} />);
      expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
      expect(screen.getByText("claude")).toBeInTheDocument();
      expect(runtime.startCli).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start" })));
      expect(runtime.startCli).toHaveBeenCalledExactlyOnceWith("cli:r2-y", "/repo", "claude");
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
