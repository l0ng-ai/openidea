import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RecentProject, RemoteTarget, Settings } from "@/platform/ipc";

const settingsSet = vi.fn();
const removeRecentProject = vi.fn();
const openProject = vi.fn();
let recent: RecentProject[] = [];

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      recentProjects: async () => recent,
      appInfo: async () => ({ version: "1.2.3" }),
      removeRecentProject: (path: string) => removeRecentProject(path),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
    },
  };
});
vi.mock("@/platform/project", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/project")>();
  return { ...real, openProject: (path: string) => openProject(path) };
});
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { registerActions } from "@/platform/actions";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { remoteLocation, useRemote } from "@/platform/remote";
import { ContextMenuHost, resolveMenuItems } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";
import { MessagesHost } from "@/workbench/messages";
import { projectInitials } from "@/workbench/projectColor";
import { useThemeOverride } from "@/workbench/theme";
import { handleListKey } from "./ProjectsPage";
import { RecentList, recentMenu } from "./RecentList";
import { filterRecent, useRecent } from "./recent";
import { WelcomeView } from "./WelcomeView";

const p = (name: string, path: string, branch: string | null = null): RecentProject => ({
  name,
  path,
  branch,
  openedAtMs: null,
});

async function renderWelcome() {
  const view = render(
    <>
      <WelcomeView />
      <ContextMenuHost />
      <MessagesHost />
    </>,
  );
  await act(async () => {});
  return view;
}

const selectedName = () =>
  screen
    .getAllByRole("option")
    .find((o) => o.getAttribute("aria-selected") === "true")
    ?.querySelector("span span")?.textContent;

beforeEach(() => {
  recent = [
    p("acme-api", "/Users/me/repo/acme-api", "dev"),
    p("delta", "/Users/me/repo/delta"),
    p("py-demo", "/tmp/py-demo"),
  ];
  settingsSet.mockReset().mockImplementation(async (_scope, key: string, raw: string) => {
    const val = JSON.parse(raw);
    const cur = useProject.getState().settings ?? ({ appearance: { theme: "light" } } as Settings);
    if (key === "keymap") return { status: "ok", data: { ...cur, keymap: val } };
    if (key.startsWith("appearance.")) {
      const prop = key.slice("appearance.".length);
      return { status: "ok", data: { ...cur, appearance: { ...cur.appearance, [prop]: val } } };
    }
    return { status: "ok", data: cur };
  });
  removeRecentProject.mockReset().mockResolvedValue({ status: "ok", data: null });
  openProject.mockReset().mockResolvedValue({});
  useRecent.setState({ projects: [], loaded: false, home: null, version: null, opening: null });
  useProject.setState({ project: null, settings: { appearance: { theme: "light" } } as Settings, opening: false });
  useThemeOverride.setState({ theme: null });
});

afterEach(() => {
  localStorage.clear();
});

describe("Welcome › Projects and Files", () => {
  it("shows Projects and Files panel, stacked actions and project rows with badges, ~ paths and branches", async () => {
    await renderWelcome();
    expect(screen.getByRole("region", { name: "Projects and Files" })).toBeTruthy();
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText(projectInitials("acme-api"))).toBeTruthy();
    expect(within(rows[0]!).getByText("~/repo/acme-api")).toBeTruthy();
    expect(within(rows[0]!).getByText("dev")).toBeTruthy();
    expect(within(rows[2]!).getByText("/tmp/py-demo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
  });

  it("shows a project whose folder is gone as unavailable", async () => {
    recent = [
      p("acme-api", "/Users/me/repo/acme-api", "dev"),
      { ...p("gone", "/Users/me/worktrees/gone"), missing: true },
    ];
    await renderWelcome();
    const [live, gone] = screen.getAllByRole("option");
    expect(live!.title).toBe("/Users/me/repo/acme-api");
    expect(gone!.title).toBe("/Users/me/worktrees/gone (unavailable)");
    expect(within(gone!).getByText("gone").className).toMatch(/unavailable/);
  });

  it("moves with arrows, filters by typing, opens with Enter and removes with Delete", async () => {
    await renderWelcome();
    const search = screen.getByLabelText("Search projects") as HTMLInputElement;
    expect(selectedName()).toBe("acme-api");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(selectedName()).toBe("delta");
    fireEvent.keyDown(search, { key: "Enter" });
    await act(async () => {});
    expect(openProject).toHaveBeenCalledWith("/Users/me/repo/delta");

    fireEvent.keyDown(search, { key: "Delete" });
    const ask = screen.getByRole("dialog", { name: "Remove Recent Project" });
    expect(removeRecentProject).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    await act(async () => {});
    expect(removeRecentProject).toHaveBeenCalledWith("/Users/me/repo/delta");
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.change(search, { target: { value: "py" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(selectedName()).toBe("py-demo");
  });

  it("leaves Delete to the search text while the caret has text after it", async () => {
    await renderWelcome();
    const search = screen.getByLabelText("Search projects") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "acme" } });
    search.setSelectionRange(1, 1);
    fireEvent.keyDown(search, { key: "Delete" });
    expect(screen.queryByRole("dialog", { name: "Remove Recent Project" })).toBeNull();
    search.setSelectionRange(4, 4);
    fireEvent.keyDown(search, { key: "Delete" });
    expect(screen.getByRole("dialog", { name: "Remove Recent Project" })).toBeTruthy();
  });

  it("offers Open in New Window in the row menu when the action exists", async () => {
    const dispose = registerActions([{ id: "file.openInNewWindow", title: "Open in New Window", run: () => {} }]);
    await renderWelcome();
    fireEvent.click(within(screen.getAllByRole("option")[0]!).getByRole("button", { name: "Project actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Open in New Window")).toBeTruthy();
    expect(within(menu).getByText("Remove from Recent Projects…")).toBeTruthy();
    dispose();
  });

  it.each([{ shiftKey: true }, { ctrlKey: true }])(
    "opens in a new window with %o, in this one with Alt, over 'Open project in'",
    async (mod) => {
      const chosen: unknown[] = [];
      const dispose = registerActions([
        { id: "file.openRecentProject", title: "Open Recent Project", run: (c) => void chosen.push(c.arg) },
      ]);
      await renderWelcome();
      const acme = { path: "/Users/me/repo/acme-api" };
      const row = () => screen.getAllByRole("option")[0]!;
      const search = screen.getByLabelText("Search projects");
      fireEvent.click(row(), mod);
      await act(async () => {});
      expect(chosen.at(-1)).toEqual({ ...acme, window: "new" });
      fireEvent.keyDown(search, { key: "Enter", ...mod });
      await act(async () => {});
      expect(chosen.at(-1)).toEqual({ ...acme, window: "new" });
      fireEvent.click(row(), { altKey: true });
      await act(async () => {});
      expect(chosen.at(-1)).toEqual({ ...acme, window: "same" });
      fireEvent.keyDown(search, { key: "Enter", altKey: true });
      await act(async () => {});
      expect(chosen.at(-1)).toEqual({ ...acme, window: "same" });
      expect(openProject).not.toHaveBeenCalled();
      dispose();
    },
  );

  it("gives File › Open Recent the same modifier keys", async () => {
    const chosen: unknown[] = [];
    const dispose = registerActions([
      { id: "file.openRecentProject", title: "Open Recent Project", run: (c) => void chosen.push(c.arg) },
    ]);
    useRecent.setState({ projects: recent, loaded: true });
    const view = render(<RecentList compact autoFocus />);
    const delta = { path: "/Users/me/repo/delta" };
    const row = screen.getAllByRole("option")[1]!;
    // As with a real click, the press selects the row and the release opens it.
    fireEvent.mouseDown(row);
    fireEvent.click(row, { ctrlKey: true });
    await act(async () => {});
    expect(chosen.at(-1)).toEqual({ ...delta, window: "new" });
    fireEvent.keyDown(screen.getByLabelText("Search recent projects"), { key: "Enter", altKey: true });
    await act(async () => {});
    expect(chosen.at(-1)).toEqual({ ...delta, window: "same" });
    view.unmount();
    dispose();
  });

  // Regression: the welcome menus are shared by the projects page and the two
  // recent-project popups, and used to hardcode "Show in Finder" on every OS.
  it("names the platform's file manager for the reveal action", () => {
    const previous = usePlatform.getState().os;
    const revealLabel = () => {
      const items = recentMenu(p("acme-api", "/Users/me/repo/acme-api"));
      return (items.find((i) => "id" in i && i.id === "reveal") as { label?: string } | undefined)?.label;
    };
    try {
      usePlatform.setState({ os: "windows" });
      expect(revealLabel()).toBe("Show in Explorer");
      usePlatform.setState({ os: "linux" });
      expect(revealLabel()).toBe("Show in Files");
      usePlatform.setState({ os: "macos" });
      expect(revealLabel()).toBe("Show in Finder");
    } finally {
      usePlatform.setState({ os: previous });
    }
  });

  it.each<{ entry: string; target: RemoteTarget | null; shown: boolean }>([
    { entry: "a local project", target: null, shown: true },
    { entry: "an SSH project", target: { kind: "ssh", config: "box" }, shown: false },
    {
      entry: "a dev-container project",
      target: { kind: "devContainer", folder: "/Users/me/app", config: "" },
      shown: false,
    },
  ])("offers the file manager for $entry only when this desktop has its folder", ({ target, shown }) => {
    const path = target ? remoteLocation(target, "/home/me/app") : "/Users/me/app";
    const items = resolveMenuItems(recentMenu(p("app", path)));
    expect(items.some((i) => i.key === "reveal")).toBe(shown);
  });

  it("changes any recent project's colour, and a local one's icon", async () => {
    const { useTabColorPicker } = await import("@/workbench/TabColorPicker");
    const local = resolveMenuItems(recentMenu(p("app", "/Users/me/app")));
    expect(local.map((i) => i.key)).toEqual(expect.arrayContaining(["color", "icon"]));
    // Nothing to reset until the project shows an icon set here.
    expect(local.some((i) => i.key === "resetIcon")).toBe(false);
    local.find((i) => i.key === "color")!.run!();
    expect(useTabColorPicker.getState().target).toMatchObject({ root: "/Users/me/app", name: "app" });
    useTabColorPicker.setState({ target: null });
    const remote = resolveMenuItems(recentMenu(p("app", remoteLocation({ kind: "ssh", config: "box" }, "/srv/app"))));
    expect(remote.map((i) => i.key)).toContain("color");
    expect(remote.map((i) => i.key)).not.toContain("icon");
  });

  it("reveals a local recent project from an SSH window's project switcher", async () => {
    useRemote.setState({
      session: { target: { kind: "ssh", config: "box" }, root: "/srv/app", host: "box", os: "linux", commands: [] },
    });
    try {
      resolveMenuItems(recentMenu(p("app", "/Users/me/app"))).find((i) => i.key === "reveal")!.run!();
      await act(async () => {});
      expect(revealItemInDir).toHaveBeenCalledExactlyOnceWith("/Users/me/app");
    } finally {
      useRemote.setState({ session: null });
    }
  });

  it("keeps the stacked actions and workspace quick actions when there are no recent projects", async () => {
    recent = [];
    await renderWelcome();
    expect(screen.getByText("No recent projects")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Markdown File" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open File" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Terminal" })).toBeTruthy();
  });

  it("opens the New dropdown with project, file, markdown file and group options", async () => {
    const dispose = registerActions([
      { id: "file.newProject", title: "New Project…", run: () => {} },
      { id: "file.newUntitled", title: "New File", run: () => {} },
      { id: "file.newMarkdownFile", title: "New Markdown File", run: () => {} },
    ]);
    try {
      await renderWelcome();
      fireEvent.click(screen.getByRole("button", { name: "New" }));
      const menu = await screen.findByRole("menu", { name: "New" });
      for (const label of ["New Project…", "New File", "New Markdown File", "New Project Group…"]) {
        expect(within(menu).getByRole("menuitem", { name: label })).toBeTruthy();
      }
    } finally {
      dispose();
    }
  });
});

describe("Welcome › workspace, panels and footer", () => {
  it("collapses and restores Projects and Files, and toggles Notifications", async () => {
    await renderWelcome();
    const panel = () => screen.queryByRole("region", { name: "Projects and Files" });
    expect(panel()).not.toBeNull();

    fireEvent.click(within(panel()!).getByRole("button", { name: "Hide" }));
    expect(panel()).toBeNull();

    const stripe = screen.getByRole("complementary", { name: "Left tool window stripe" });
    fireEvent.click(within(stripe).getByRole("button", { name: "Projects and Files" }));
    expect(panel()).not.toBeNull();

    const rightStripe = screen.getByRole("complementary", { name: "Right tool window stripe" });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    fireEvent.click(within(rightStripe).getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
  });

  it("runs New Markdown File, Open File and Open Terminal from the workspace canvas", async () => {
    const ran: string[] = [];
    const dispose = registerActions([
      { id: "file.newMarkdownFile", title: "New Markdown File", run: () => void ran.push("md") },
      { id: "file.openFile", title: "Open File", run: () => void ran.push("open") },
      { id: "terminal.openStandalone", title: "Open Terminal", run: () => void ran.push("term") },
    ]);
    try {
      await renderWelcome();
      fireEvent.click(screen.getByRole("button", { name: "New Markdown File" }));
      fireEvent.click(screen.getByRole("button", { name: "Open File" }));
      fireEvent.click(screen.getByRole("button", { name: "Open Terminal" }));
      expect(ran).toEqual(["md", "open", "term"]);
    } finally {
      dispose();
    }
  });

  it("opens Plugins via plugins.settings when registered, or inline when only the page is contributed", async () => {
    await renderWelcome();
    expect(screen.queryByRole("button", { name: "Plugins" })).toBeNull();

    const disposePage = registerSettingsPage({
      id: "plugins",
      title: "Plugins",
      component: () => <div>plugin page</div>,
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(screen.getByText("plugin page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("plugin page")).toBeNull();

    let opened = 0;
    const disposeAction = registerActions([{ id: "plugins.settings", title: "Plugins…", run: () => void opened++ }]);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(opened).toBe(1);
    disposeAction();
    disposePage();
  });

  it("switches Theme, Sync with OS, and Keymap from the workspace footer", async () => {
    await renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: /Theme: Islands Light/ }));
    const themeMenu = await screen.findByRole("menu", { name: "Theme" });
    fireEvent.click(within(themeMenu).getByRole("menuitemcheckbox", { name: "Islands Dark" }));
    await act(async () => {});
    expect(settingsSet).toHaveBeenCalledWith("global", "appearance.theme", '"dark"');

    fireEvent.click(screen.getByRole("button", { name: /Theme:/ }));
    const themeMenu2 = await screen.findByRole("menu", { name: "Theme" });
    fireEvent.click(within(themeMenu2).getByRole("menuitemcheckbox", { name: "Sync with OS" }));
    await act(async () => {});
    expect(settingsSet).toHaveBeenCalledWith("global", "appearance.syncWithOs", "true");

    fireEvent.click(screen.getByRole("button", { name: /Keymap: macOS/ }));
    const keymapMenu = await screen.findByRole("menu", { name: "Keymap" });
    fireEvent.click(within(keymapMenu).getByRole("menuitemcheckbox", { name: "VS Code (macOS)" }));
    await act(async () => {});
    expect(settingsSet).toHaveBeenCalledWith("global", "keymap", '"vscode-macos"');
  });
});

describe("helpers", () => {
  it("maps list keys", () => {
    const items = filterRecent([p("a", "/a"), p("b", "/b")], "");
    expect(
      handleListKey({ key: "ArrowDown", metaKey: false, shiftKey: false }, { items, current: 0, caretAtEnd: true }),
    ).toEqual({
      kind: "move",
      index: 1,
    });
    expect(
      handleListKey({ key: "Delete", metaKey: false, shiftKey: false }, { items, current: 1, caretAtEnd: false }),
    ).toBeNull();
    expect(
      handleListKey({ key: "Delete", metaKey: false, shiftKey: false }, { items, current: 1, caretAtEnd: true }),
    ).toMatchObject({
      kind: "remove",
      match: { project: { path: "/b" } },
    });
    expect(
      handleListKey({ key: "Enter", metaKey: false, shiftKey: false }, { items: [], current: 0, caretAtEnd: true }),
    ).toBeNull();
  });
});
