import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provideToolWindowService, type ToolWindowService } from "@/workbench/contributions";
import { closeAll, getSession, newTab, useTerminals } from "./store";

const { focused } = vi.hoisted(() => ({ focused: [] as string[] }));

vi.mock("./session", () => ({
  TerminalSession: class {
    key: string;
    state = { cwd: "/repo" };
    private readonly onExit: ((key: string) => void) | undefined;
    constructor(opts: { key: string; onExit?: (key: string) => void }) {
      this.key = opts.key;
      this.onExit = opts.onExit;
    }
    exited() {
      this.onExit?.(this.key);
    }
    focus() {
      focused.push(this.key);
    }
    dispose() {}
  },
}));

const hide = vi.fn();
beforeEach(() => {
  hide.mockClear();
  focused.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  provideToolWindowService({ hide } as unknown as ToolWindowService);
  closeAll();
});
afterEach(() => vi.unstubAllGlobals());

function shellExit(key: string) {
  (getSession(key) as unknown as { exited(): void }).exited();
}

describe("shell exit closes the last tab", () => {
  it("hides the Terminal tool window", () => {
    const tab = newTab("/repo");
    shellExit(tab.session);
    expect(useTerminals.getState().tabs).toHaveLength(0);
    expect(hide).toHaveBeenCalledWith("terminal");
  });

  it("keeps it open while another session is running", () => {
    const a = newTab("/repo");
    newTab("/repo");
    shellExit(a.session);
    expect(hide).not.toHaveBeenCalled();
  });
});

describe("shell exit with sessions left", () => {
  it("focuses the session that takes over the active tab", () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    shellExit(b.session);
    expect(useTerminals.getState().activeTab).toBe(a.id);
    expect(focused).toContain(a.session);
  });

  it("focuses the active session when a background shell exits", () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    shellExit(a.session);
    expect(focused).toContain(b.session);
  });
});
