import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { useContributedIconThemes } from "@/platform/themes";
import { fileIconName, iconMarkup, themedFolderIconName, useFileIconRevision } from "@/ui";
import { useIconRowHeight } from "@/ui/iconAppearance";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { addIconTheme, selectIconTheme, trackIconTheme, useIconThemes } from "../iconThemes";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>';
const MAP = {
  file: "file",
  folder: "folder",
  fileExtensions: {},
  fileNames: {},
  folderNames: {},
  patterns: [
    {
      pattern: "^.*\\.spec\\.ts$",
      icon: "test",
      target: "file",
      path: false,
      ignoreCase: false,
      group: null,
      openIcon: null,
    },
  ],
  overrides: { "chevron-right": "arrow" },
  groups: [{ id: "extra", name: "Extra", enabled: false }],
  choices: [],
  accent: true,
};

const savedProject = useProject.getState();
let stop: (() => void) | null = null;

function setOptions(options: unknown) {
  useProject.setState({
    settings: { ...useProject.getState().settings, appearance: { fileIconThemeOptions: { "p/t": options } } } as never,
  });
}

afterEach(() => {
  stop?.();
  stop = null;
  useIconThemes.setState({ override: undefined, available: new Map() });
  useContributedIconThemes.setState({ themes: [] });
  useProject.setState(savedProject, true);
  setPluginsBackend(null);
});

describe("plugin icon themes", () => {
  it("applies the theme's patterns, overrides and the user's options", async () => {
    const backend = createMemoryPluginsBackend([]);
    setPluginsBackend({
      ...backend,
      assets: async () => [
        ["iconTheme/t/map", JSON.stringify(MAP)],
        ...["file", "folder", "test", "arrow"].map((icon) => [`iconTheme/t/svg/${icon}`, SVG] as [string, string]),
      ],
    });
    addIconTheme({ pluginId: "p", id: "t", label: "T" });
    stop = trackIconTheme();
    await selectIconTheme("p/t");
    await waitFor(() => expect(fileIconName("a.spec.ts")).toBe("ext:p/t/test"));
    expect(fileIconName("a.rs")).toBe("ext:p/t/file");
    expect(iconMarkup("chevron-right")).toContain("M0 0h16v16z");

    const revision = useFileIconRevision.getState();
    setOptions({});
    useProject.setState({ settings: { ...useProject.getState().settings } as never });
    expect(useFileIconRevision.getState()).toBe(revision);

    setOptions({ hideFiles: true, rowHeight: 30 });
    expect(fileIconName("a.spec.ts")).toBe("ext:p/t/__hidden");
    expect(themedFolderIconName("src")).toBe("ext:p/t/folder");
    expect(useIconRowHeight.getState()).toBe(30);

    await selectIconTheme(null);
    await waitFor(() => expect(fileIconName("a.spec.ts")).not.toMatch(/^ext:/));
    expect(iconMarkup("chevron-right")).not.toContain("M0 0h16v16z");
    expect(useIconRowHeight.getState()).toBeNull();
  });

  it("offers the theme's settings whether or not it is selected", async () => {
    const SETTINGS = { groups: MAP.groups, choices: [], accent: true, settings: [{ title: "T", items: [] }] };
    const requested: string[] = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend([]),
      assets: async (plugin, prefix) => {
        requested.push(prefix);
        return plugin === "acme.icons" ? [["iconTheme/t/settings", JSON.stringify(SETTINGS)]] : [];
      },
    });
    const remove = addIconTheme({ pluginId: "acme.icons", id: "t", label: "T", settingsPage: "plugins.acme-icons.t" });
    addIconTheme({ pluginId: "plain", id: "t", label: "T" });
    const of = (id: string) => useContributedIconThemes.getState().themes.find((t) => t.id === id)!;
    expect(of("acme.icons/t").settingsPage).toBe("plugins.acme-icons.t");
    expect(await of("acme.icons/t").details!()).toEqual(SETTINGS);
    expect(await of("plain/t").details!()).toBeNull();
    expect(requested).toEqual(["iconTheme/t/settings", "iconTheme/t/settings"]);
    remove();
    expect(useContributedIconThemes.getState().themes.some((t) => t.id === "acme.icons/t")).toBe(false);
  });
});
