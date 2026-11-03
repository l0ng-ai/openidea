import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RecentProject, Settings } from "@/platform/ipc";

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
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { ContextMenuHost } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";
import { MessagesHost } from "@/workbench/messages";
import { projectInitials } from "@/workbench/projectColor";
import { handleListKey } from "./ProjectsPage";
import { customizeView } from "./CustomizePage";
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
  settingsSet.mockReset().mockImplementation(async () => ({ status: "ok", data: { appearance: {} } as Settings }));
  removeRecentProject.mockReset().mockResolvedValue({ status: "ok", data: null });
  openProject.mockReset().mockResolvedValue({});
  useRecent.setState({ projects: [], loaded: false, home: null, version: null, opening: null });
  useProject.setState({ project: null, settings: { appearance: { theme: "light" } } as Settings, opening: false });
});

afterEach(() => {
  localStorage.clear();
});

describe("Welcome › Projects", () => {
  it("shows brand, version and project rows with badges, ~ paths and branches", async () => {
    await renderWelcome();
    expect(screen.getByText("OpenIDEA")).toBeTruthy();
    expect(screen.getByText("1.2.3")).toBeTruthy();
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText(projectInitials("acme-api"))).toBeTruthy();
    expect(within(rows[0]!).getByText("~/repo/acme-api")).toBeTruthy();
    expect(within(rows[0]!).getByText("dev")).toBeTruthy();
    expect(within(rows[2]!).getByText("/tmp/py-demo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
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

  it("offers Open in New Window in the row menu when the action exists", async () => {
    const dispose = registerActions([{ id: "file.openInNewWindow", title: "Open in New Window", run: () => {} }]);
    await renderWelcome();
    fireEvent.click(within(screen.getAllByRole("option")[0]!).getByRole("button", { name: "Project actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Open in New Window")).toBeTruthy();
    expect(within(menu).getByText("Show in Finder")).toBeTruthy();
    expect(within(menu).getByText("Remove from Recent Projects…")).toBeTruthy();
    dispose();
  });

  it("offers New Project, with a language menu, beside Open", async () => {
    const run = vi.fn();
    const dispose = registerActions([{ id: "file.newProject", title: "New Project…", run }]);
    await renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    expect(run).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New Project…" }));
    const menu = await screen.findByRole("menu", { name: "New Project…" });
    expect(within(menu).getByText("Empty Project")).toBeTruthy();
    expect(within(menu).getByText("Web")).toBeTruthy();
    expect(within(menu).getByText("JVM")).toBeTruthy();
    dispose();
  });

  it("shows the landing page without recent projects", async () => {
    recent = [];
    await renderWelcome();
    expect(screen.getByText("Welcome to OpenIDEA")).toBeTruthy();
    expect(screen.queryByLabelText("Search projects")).toBeNull();
  });
});

describe("Welcome › navigation", () => {
  it("lists Plugins only when the plugins settings page is contributed, and embeds it", async () => {
    await renderWelcome();
    expect(screen.queryByRole("button", { name: "Plugins" })).toBeNull();
    const dispose = registerSettingsPage({ id: "plugins", title: "Plugins", component: () => <div>plugin page</div> });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(screen.getByText("plugin page")).toBeTruthy();
    act(() => dispose());
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
  });

  it("Customize writes the global settings keys", async () => {
    await renderWelcome();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(screen.getByRole("radio", { name: "Purple" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Sync with OS" }));
    await act(async () => {});
    expect(settingsSet).toHaveBeenCalledWith("global", "appearance.accent", '"#955ae0"');
    expect(settingsSet).toHaveBeenCalledWith("global", "appearance.syncWithOs", "true");
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

  it("derives the Customize view from partial settings", () => {
    expect(customizeView(null)).toMatchObject({
      theme: "light",
      syncWithOs: false,
      fontSize: 13,
      keymap: "intellij-macos",
    });
    expect(
      customizeView({
        appearance: { theme: "system", useCustomFont: true, uiFontSize: 15 },
        keymap: "vscode-macos",
      } as Settings),
    ).toMatchObject({ theme: "light", syncWithOs: true, fontSize: 15, keymap: "vscode-macos" });
    expect(customizeView({ appearance: { uiFontSize: 15 } } as Settings).fontSize).toBe(13);
  });
});
