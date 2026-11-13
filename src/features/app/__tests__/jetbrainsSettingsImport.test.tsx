import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const read = vi.fn();
const set = vi.fn();
const notify = vi.fn();
const editor = { fontSize: 13, customSchemes: {}, colorOverrides: {} };

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      settingsReadJetbrains: (path: string) => read(path),
      settingsGetGlobal: async () => ({ editor }),
      settingsSet: (scope: string, key: string, value: string) => set(scope, key, value),
    },
  };
});
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
        "options/colors.scheme.xml":
          '<application><component name="EditorColorsManagerImpl"><global_color_scheme name="Custom" />' +
          "</component></application>",
      },
    },
  });
  set.mockResolvedValue({ status: "ok", data: { editor } });
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
  expect(screen.getByText(/Not imported:/)).toHaveTextContent("Keymap, Plugins");
  expect(set).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
    await done;
  });
  if (button === "Cancel") {
    expect(set).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
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
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Settings imported" }));
  }
});
