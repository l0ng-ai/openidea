import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InstalledIntellijTheme, InstallPreview, IntellijThemeSource } from "@/bindings";
import { IpcError } from "@/platform/ipc";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { useThemeOverride } from "@/workbench/theme";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import { closeInstalledIntellijThemes, importIntellijTheme, showInstalledIntellijThemes } from "../intellijImport";
import { IntellijThemesDialogHost } from "../IntellijThemesDialog";
import { setConsentPrompt } from "../store";

type Note = Parameters<NotificationService["notify"]>[0];
const ID = "intellij.com-example-deepsea";
const SOURCE: IntellijThemeSource = {
  name: "Deep Sea Themes",
  pluginId: "com.example.deepsea",
  version: "2.3",
  vendor: "Someone",
  themes: [
    { id: "deep-id", theme: '{"name":"Deep Sea","dark":true,"ui":{"*":{"background":"#101820"}}}', editorScheme: null },
    { id: "shallow-id", theme: '{"name":"Shallow","dark":false}', editorScheme: null },
  ],
};
const INSTALLED: InstalledIntellijTheme[] = [
  {
    ide: "IntelliJ IDEA 2025.2",
    plugin: "Deep Sea Themes",
    path: "/ij/plugins/DeepSea",
    themeId: "shallow-id",
    themeName: "Shallow",
    dark: false,
    active: true,
  },
  {
    ide: "IntelliJ IDEA 2025.2",
    plugin: "Deep Sea Themes",
    path: "/ij/plugins/DeepSea",
    themeId: "deep-id",
    themeName: "Deep Sea",
    dark: true,
    active: false,
  },
];

let notes: Note[];
let read: Mock<PluginsBackend["readIntellijTheme"]>;
let stage: Mock<PluginsBackend["stagePackage"]>;
let installed: string[];

function backend(overrides: Partial<PluginsBackend> = {}): PluginsBackend {
  const base = createMemoryPluginsBackend();
  const preview: InstallPreview = {
    id: ID,
    name: SOURCE.name,
    version: "2.3.0",
    description: "",
    authors: ["Someone"],
    hasCode: false,
    capabilities: [],
    contributions: [{ point: "themes", count: 2 }],
    warnings: [],
    replaces: null,
    unsigned: true,
    publisher: null,
    signerChanged: false,
    needsConsent: true,
  };
  return {
    ...base,
    readIntellijTheme: read,
    stagePackage: stage,
    installedIntellijThemes: async () => INSTALLED,
    previewInstall: async () => preview,
    installDir: async (path) => {
      installed.push(path);
      const [template] = (await base.list()).plugins;
      return { ...template!, id: ID, name: SOURCE.name, hasCode: false, status: "static" };
    },
    ...overrides,
  };
}

beforeEach(() => {
  notes = [];
  installed = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  read = vi.fn<PluginsBackend["readIntellijTheme"]>(async () => SOURCE);
  stage = vi.fn<PluginsBackend["stagePackage"]>(async () => "/app/plugins/.downloads/generated");
  setPluginsBackend(backend());
  setConsentPrompt(async () => ({ optional: [] }));
  useThemeOverride.setState({ theme: null });
});

afterEach(() => {
  closeInstalledIntellijThemes();
  setConsentPrompt(null);
  setPluginsBackend(null);
  useThemeOverride.setState({ theme: null });
});

describe("IntelliJ theme import", () => {
  it("installs the converted plugin through the install page and applies the chosen theme", async () => {
    expect(await importIntellijTheme("/downloads/DeepSea.zip", "shallow-id")).toBe(ID);
    expect(read).toHaveBeenCalledWith("/downloads/DeepSea.zip");
    const [name, files] = stage.mock.calls[0]!;
    expect(name).toBe(ID);
    expect(files.map((f) => f.path)).toEqual([
      "plugin.toml",
      "themes/deep-sea.theme.json",
      "themes/shallow.theme.json",
    ]);
    expect(installed).toEqual(["/app/plugins/.downloads/generated"]);
    expect(useThemeOverride.getState().theme).toBe(`plugin:${ID}/shallow`);
  });

  it("applies the first theme without a choice, and nothing when the install is declined", async () => {
    expect(await importIntellijTheme("/downloads/DeepSea.jar")).toBe(ID);
    expect(useThemeOverride.getState().theme).toBe(`plugin:${ID}/deep-sea`);

    useThemeOverride.setState({ theme: null });
    setConsentPrompt(async () => null);
    expect(await importIntellijTheme("/downloads/DeepSea.jar")).toBeNull();
    expect(useThemeOverride.getState().theme).toBeNull();
  });

  it("asks for a file without a path, and does nothing when the picker is cancelled", async () => {
    const pick = vi.fn(async () => null);
    setPluginsBackend(backend({ pickIntellijTheme: pick }));
    expect(await importIntellijTheme()).toBeNull();
    expect(pick).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it("reports a file that is not a theme plugin", async () => {
    read.mockRejectedValueOnce(
      new IpcError({
        kind: "invalidInput",
        message: "tools.jar is not a theme plugin: its plugin.xml declares no themeProvider",
      }),
    );
    expect(await importIntellijTheme("/downloads/tools.jar")).toBeNull();
    expect(stage).not.toHaveBeenCalled();
    expect(notes).toEqual([
      expect.objectContaining({
        level: "error",
        title: "Could not import the IntelliJ theme",
        body: expect.stringContaining("not a theme plugin"),
      }),
    ]);
  });
});

describe("Import Theme from IntelliJ IDE", () => {
  it("lists the installed themes by plugin, the one in use first, and imports the chosen one", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    render(<IntellijThemesDialogHost />);
    act(() => showInstalledIntellijThemes(onImported));
    const list = await screen.findByRole("listbox", { name: "IntelliJ themes" });
    const options = await waitFor(() => {
      const found = Array.from(list.querySelectorAll('[role="option"]'));
      expect(found).toHaveLength(2);
      return found;
    });
    // Both under their plugin's heading: importing one brings the plugin's every theme.
    expect(within(list).getByText("Deep Sea Themes")).toBeInTheDocument();
    expect(within(list).getByText("2 themes")).toBeInTheDocument();
    expect(within(list).getByText("IntelliJ IDEA 2025.2")).toBeInTheDocument();
    expect(options[0]).toHaveTextContent("Shallow");
    expect(options[0]).toHaveTextContent("In use");
    expect(options[1]).toHaveTextContent("Deep Sea");
    expect(options[1]).not.toHaveTextContent("In use");

    await user.click(screen.getByText("Deep Sea"));
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(ID));
    expect(read).toHaveBeenCalledWith("/ij/plugins/DeepSea");
    expect(useThemeOverride.getState().theme).toBe(`plugin:${ID}/deep-sea`);
    expect(screen.queryByRole("listbox", { name: "IntelliJ themes" })).toBeNull();
  });

  it("offers a file when no IDE has theme plugins", async () => {
    const user = userEvent.setup();
    const pick = vi.fn(async () => "/downloads/DeepSea.jar");
    setPluginsBackend(backend({ installedIntellijThemes: async () => [], pickIntellijTheme: pick }));
    render(<IntellijThemesDialogHost />);
    act(() => showInstalledIntellijThemes());
    expect(await screen.findByText(/No theme plugins found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Choose File…" }));
    await waitFor(() => expect(read).toHaveBeenCalledWith("/downloads/DeepSea.jar"));
    expect(pick).toHaveBeenCalledOnce();
  });
});
