import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const read = vi.fn();
const set = vi.fn();
const notify = vi.fn();
const execute = vi.fn();
const market = [
  { id: "ruyimg.codeglance-pro", name: "CodeGlance Pro", installed: null, compatible: true },
  { id: "solhovoy.grep-console", name: "Grep Console", installed: null, compatible: true },
];
const editor = { fontFamily: "JetBrains Mono", fontSize: 13, customSchemes: {}, colorOverrides: {} };

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      settingsReadJetbrains: (path: string) => read(path),
      settingsGetGlobal: async () => ({ editor }),
      settingsSet: (scope: string, key: string, value: string) => set(scope, key, value),
      pluginMarket: async () => ({ status: "ok", data: market }),
    },
  };
});
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: (id: string, arg?: unknown) => execute(id, arg),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const { importJetBrainsSettings } = await import("../jetbrainsSettings");
const { MessagesHost } = await import("@/workbench/messages");

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({
    status: "ok",
    data: {
      entries: ["keymaps/custom.xml", "installed.txt"],
      files: {
        "options/editor-font.xml":
          '<application><component name="DefaultFont"><option name="FONT_FAMILY" value="Monaco" />' +
          '<option name="FONT_SIZE" value="17" /></component></application>',
        "colors/custom.icls": '<scheme name="Custom" version="142" parent_scheme="Darcula"><attributes /></scheme>',
        "installed.txt": "IdeaVIM\ncom.nasller.CodeGlancePro\nGrepConsole\nsome.unknown.plugin\n",
        "disabled_plugins.txt": "GrepConsole\n",
        "options/colors.scheme.xml":
          '<application><component name="EditorColorsManagerImpl"><global_color_scheme name="Custom" />' +
          "</component></application>",
      },
    },
  });
  set.mockResolvedValue({ status: "ok", data: { editor } });
  // jsdom has no canvas: the import falls back to the font size for the line height.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

it.each(["Cancel", "Import"])("confirms folder settings before applying them: %s", async (button) => {
  render(<MessagesHost />);
  let done!: Promise<void>;
  await act(async () => {
    done = importJetBrainsSettings("/settings/PyCharm2026.1");
  });
  expect(read).toHaveBeenCalledExactlyOnceWith("/settings/PyCharm2026.1");
  expect(screen.getByText("Monaco")).toBeInTheDocument();
  expect(screen.getByText("17")).toBeInTheDocument();
  expect(screen.getAllByText("Custom")).toHaveLength(2);
  expect(screen.getByText("CodeGlance Pro")).toBeInTheDocument();
  expect(screen.getByText("Enable Vim emulation")).toBeInTheDocument();
  expect(screen.getByText(/Not imported:/)).toHaveTextContent("Grep Console (disabled)");
  expect(screen.getByText(/Plugins without a counterpart/)).toHaveTextContent("some.unknown.plugin");
  expect(set).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
    await done;
  });
  if (button === "Cancel") {
    expect(set).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } else {
    const writes = Object.fromEntries(
      set.mock.calls.map(([scope, key, value]) => {
        expect(scope).toBe("global");
        return [key, JSON.parse(value)];
      }),
    );
    const [id] = Object.keys(writes["editor.customSchemes"]);
    expect(writes).toEqual({
      "editor.customSchemes": expect.objectContaining({ [id!]: expect.objectContaining({ name: "Custom" }) }),
      "editor.colorScheme": id,
      "editor.fontFamily": "Monaco",
      "editor.fontSize": 17,
      "editor.lineHeight": 25,
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Settings imported" }));
    expect(execute).toHaveBeenCalledExactlyOnceWith("vim.toggle", undefined);
    const offer = notify.mock.calls.map(([n]) => n).find((n) => n.key === "app.settingsImport.plugins");
    expect(offer.body).toBe("CodeGlance Pro");
    await act(async () => offer.actions[0].run());
    expect(execute).toHaveBeenLastCalledWith("plugins.installFromMarket", "ruyimg.codeglance-pro");
  }
});

it("offers an imported inspection profile for the open project", async () => {
  const { useProject } = await import("@/platform/project");
  useProject.setState({ project: { root: "/p", name: "p" } as never });
  read.mockResolvedValue({
    status: "ok",
    data: {
      entries: ["inspection/Strict.xml"],
      files: {
        "inspection/Strict.xml":
          '<profile version="1.0"><option name="myName" value="Strict" />' +
          '<inspection_tool class="SpellCheckingInspection" enabled="false" level="TYPO" enabled_by_default="false" />' +
          "</profile>",
      },
    },
  });
  render(<MessagesHost />);
  let done!: Promise<void>;
  await act(async () => {
    done = importJetBrainsSettings("/settings.zip");
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await done;
  });
  const offer = notify.mock.calls.map(([n]) => n).find((n) => n.key === "app.settingsImport.inspections");
  expect(offer.actions.map((a: { label: string }) => a.label)).toEqual(["Use Strict"]);
  await act(async () => offer.actions[0].run());
  expect(set).toHaveBeenLastCalledWith("project", "inspections.profile", '"ide:strict"');
  useProject.setState({ project: null });
});
