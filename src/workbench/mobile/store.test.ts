import { afterEach, describe, expect, it, vi } from "vitest";
import { provideEditorService, type EditorInput, type EditorService } from "../contributions";
import { useToolWindowLayout } from "../toolwindows/store";
import {
  installMobileShellFollow,
  pageOfToolWindow,
  popEditor,
  setMobilePage,
  toolWindowOfPage,
  useMobileShell,
} from "./store";

afterEach(() => useMobileShell.setState({ page: "editor", gitView: "commit", returnTo: null, pushed: null }, true));

/** An editor service whose tabs the test opens. */
function fakeEditor() {
  let listener: ((input: EditorInput | null) => void) | null = null;
  const tabs: EditorInput[] = [];
  const closeInput = vi.fn(async (key: string) => {
    tabs.splice(
      tabs.findIndex((t) => t.key === key),
      1,
    );
    // The editor activates the tab left in its place.
    listener?.(tabs.at(-1) ?? null);
    return true;
  });
  const service = {
    openTabs: () => tabs.map((input) => ({ input })),
    onActiveInputChange: (fn: (input: EditorInput | null) => void) => {
      listener = fn;
      return () => (listener = null);
    },
    closeInput,
  } as unknown as EditorService;
  provideEditorService(service);
  return {
    closeInput,
    open(key: string) {
      const input = { kind: "diff", key, data: {} } as EditorInput;
      if (!tabs.some((t) => t.key === key)) tabs.push(input);
      listener?.(input);
    },
  };
}

describe("phone shell pages", () => {
  it("gives Agents, Git and Database their own page and everything else a page under More", () => {
    expect(pageOfToolWindow("agents")).toBe("agents");
    expect(pageOfToolWindow("commit")).toBe("git");
    expect(pageOfToolWindow("git")).toBe("git");
    expect(pageOfToolWindow("terminal")).toBe("tool:terminal");
  });

  it("shows the chosen Git view, or the one registered", () => {
    const all = () => true;
    expect(toolWindowOfPage("git", "git", all)).toBe("git");
    expect(toolWindowOfPage("git", "commit", (id) => id === "git")).toBe("git");
    expect(toolWindowOfPage("tool:terminal", "commit", all)).toBe("terminal");
    expect(toolWindowOfPage("editor", "commit", all)).toBeNull();
  });

  it("turns to the page of a tool window something shows", () => {
    fakeEditor();
    const off = installMobileShellFollow();
    try {
      useToolWindowLayout.setState({ lastActive: "git" });
      expect(useMobileShell.getState()).toMatchObject({ page: "git", gitView: "git" });
      useToolWindowLayout.setState({ lastActive: "terminal" });
      expect(useMobileShell.getState().page).toBe("tool:terminal");
    } finally {
      off();
      useToolWindowLayout.setState({ lastActive: null });
    }
  });

  it("shows an editor opened from a page over it, and Back returns there closing the new tab", () => {
    const editor = fakeEditor();
    const off = installMobileShellFollow();
    try {
      editor.open("file:a");
      setMobilePage("git");
      editor.open("diff:a");
      expect(useMobileShell.getState()).toMatchObject({ page: "editor", returnTo: "git", pushed: "diff:a" });
      popEditor();
      expect(useMobileShell.getState()).toMatchObject({ page: "git", returnTo: null });
      expect(editor.closeInput).toHaveBeenCalledWith("diff:a");
      // `file:a` becoming active again does not bring the editor back over Git.
      expect(useMobileShell.getState().page).toBe("git");
    } finally {
      off();
    }
  });

  it("keeps a tab that was open already when going back, and leaves the Editor tab alone", () => {
    const editor = fakeEditor();
    const off = installMobileShellFollow();
    try {
      editor.open("file:a");
      expect(useMobileShell.getState()).toMatchObject({ page: "editor", returnTo: null });
      setMobilePage("agents");
      editor.open("file:a");
      expect(useMobileShell.getState()).toMatchObject({ page: "editor", returnTo: "agents", pushed: null });
      popEditor();
      expect(editor.closeInput).not.toHaveBeenCalled();
      expect(useMobileShell.getState().page).toBe("agents");
    } finally {
      off();
    }
  });
});
