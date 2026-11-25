import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** Writes the dotted key into the current settings, as the host does. */
const ipc = vi.hoisted(() => ({
  settingsSet: vi.fn(async (_scope: string, key: string, value: string) => {
    const { useProject } = await import("@/platform/project");
    const settings = structuredClone(useProject.getState().settings ?? {}) as Record<string, unknown>;
    const path = key.split(".");
    let node = settings;
    for (const part of path.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[path.at(-1)!] = JSON.parse(value);
    return { status: "ok" as const, data: settings };
  }),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const { actionToggled, executeAction, getAction } = await import("@/platform/actions");
const { registerEditorActions } = await import("./actions");
const { gutterMenuItems } = await import("./gutterMenu");
const { useProject } = await import("@/platform/project");
const { resolveActionId } = await import("@/features/vim/rc");

let dispose: () => void;
beforeAll(() => {
  dispose = registerEditorActions();
});
afterAll(() => dispose());
afterEach(() => {
  useProject.setState({ settings: null });
  vi.clearAllMocks();
});

const switches = [
  { id: "editor.toggleLineNumbers", key: "editor.appearance.lineNumbers", title: "Show Line Numbers", on: true },
  { id: "editor.toggleIndentGuides", key: "editor.appearance.indentGuides", title: "Show Indent Guides", on: true },
  { id: "editor.toggleStickyLines", key: "editor.stickyScroll", title: "Show Sticky Lines", on: true },
  { id: "editor.toggleWhitespaces", key: "editor.showWhitespace", title: "Show Whitespaces", on: false },
];

describe("editor appearance toggle actions", () => {
  it.each(switches)("$title flips the global setting both ways", async ({ id, key, title, on }) => {
    const action = getAction(id);
    expect(action?.title).toBe(title);
    expect(action?.category).toBe("View");
    expect(actionToggled(action)).toBe(on);

    expect(await executeAction(id)).toBe(true);
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("global", key, String(!on));
    expect(actionToggled(action)).toBe(!on);

    await executeAction(id);
    expect(ipc.settingsSet).toHaveBeenLastCalledWith("global", key, String(on));
    expect(actionToggled(action)).toBe(on);
    expect(ipc.settingsSet).toHaveBeenCalledTimes(2);
  });

  it("reads the saved value, not the default", () => {
    useProject.setState({
      settings: { editor: { stickyScroll: false, showWhitespace: true, appearance: { lineNumbers: false } } } as never,
    });
    expect(actionToggled(getAction("editor.toggleStickyLines"))).toBe(false);
    expect(actionToggled(getAction("editor.toggleWhitespaces"))).toBe(true);
    expect(actionToggled(getAction("editor.toggleLineNumbers"))).toBe(false);
    expect(actionToggled(getAction("editor.toggleIndentGuides"))).toBe(true);
  });

  it("maps IDEA's gutter Appearance actions", () => {
    expect(resolveActionId("EditorGutterToggleGlobalLineNumbers")).toBe("editor.toggleLineNumbers");
    expect(resolveActionId("EditorGutterToggleGlobalIndentLines")).toBe("editor.toggleIndentGuides");
    expect(resolveActionId("EditorGutterToggleGlobalStickyLines")).toBe("editor.toggleStickyLines");
  });
});

describe("gutter Appearance menu", () => {
  const slot = {
    model: { path: "/p/a.ts", softWrapOn: () => false, renderedDocsOn: () => false },
    currentState: () => ({ doc: { toString: () => "" } }),
  };
  const appearance = () => {
    const items = gutterMenuItems(slot as never, 1) as { label?: string; submenu?: unknown[] }[];
    return items.find((i) => i.label === "Appearance")!.submenu as {
      label: string;
      checked?: boolean;
      run?: () => void;
    }[];
  };

  it("lists Show Sticky Lines after Show Indent Guides, checked by default", () => {
    const labels = appearance().map((i) => i.label);
    expect(labels.slice(0, 6)).toEqual([
      "Show Line Numbers",
      "Show Gutter Icons",
      "Show Folding Outline",
      "Show Indent Guides",
      "Show Sticky Lines",
      "Show Whitespaces",
    ]);
    expect(appearance().find((i) => i.label === "Show Sticky Lines")?.checked).toBe(true);
  });

  it("switches the same setting as the action", async () => {
    appearance().find((i) => i.label === "Show Sticky Lines")!.run!();
    await vi.waitFor(() => expect(ipc.settingsSet).toHaveBeenCalledWith("global", "editor.stickyScroll", "false"));
    await vi.waitFor(() => expect(actionToggled(getAction("editor.toggleStickyLines"))).toBe(false));
  });
});
