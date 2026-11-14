import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provideToolWindowService, type ToolWindowService } from "@/workbench/contributions";
import { closeAll, getSession, newTab, useTerminals } from "./store";

const { focused } = vi.hoisted(() => ({ focused: [] as string[] }));

vi.mock("./session", () => ({
  TerminalSession: class {
    key: string;
    state = { cwd: "/repo" };
    host = document.createElement("div");
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
  /** Puts the caret in `key`'s terminal, as typing into it would. */
  function typeInto(key: string) {
    const host = (getSession(key) as unknown as { host: HTMLDivElement }).host;
    const input = document.createElement("textarea");
    host.appendChild(input);
    document.body.appendChild(host);
    input.focus();
  }

  it("focuses the session that takes over the active tab", () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    typeInto(b.session);
    shellExit(b.session);
    expect(useTerminals.getState().activeTab).toBe(a.id);
    expect(focused).toContain(a.session);
  });

  it("refocuses the active session when the terminal has the caret and a background shell exits", () => {
    const a = newTab("/repo");
    const b = newTab("/repo");
    typeInto(b.session);
    shellExit(a.session);
    expect(focused).toContain(b.session);
  });

  it("leaves the caret where it is when the terminal does not have it", () => {
    const a = newTab("/repo");
    newTab("/repo");
    const editor = document.createElement("input");
    document.body.appendChild(editor);
    editor.focus();
    shellExit(a.session);
    expect(focused).toEqual([]);
    expect(document.activeElement).toBe(editor);
  });
});
