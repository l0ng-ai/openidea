import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSettingsFormFor } from "@/features/settings/components/context";
import { executeAction } from "@/platform/actions";
import { SettingsFormContext } from "@/workbench/contributions";
import { activate } from "../index";
import { vimExtension } from "../engine";
import { useVimRc } from "../rcFile";
import { useVimSettings } from "../settings";
import { VIM_SETTINGS_PAGE } from "../settingsPages";
import { VimSettingsPage } from "../VimSettingsPage";

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home",
  join: async (...paths: string[]) => paths.join("/"),
}));

let rc: string;
let dispose: () => void;
let view: EditorView;

beforeEach(() => {
  rc = "nnoremap z 0";
  mockWindows("main");
  mockIPC((cmd) => (cmd === "fs_read_text" ? rc : undefined));
  useVimRc.setState({ path: null, mappings: 0, ignored: [], loaded: false });
  useVimSettings.setState({ enabled: true, handlers: {} }, true);
  dispose = activate();
  view = new EditorView({ doc: "abcdef", extensions: vimExtension() });
});

afterEach(() => {
  cleanup();
  view.destroy();
  dispose();
  clearMocks();
  Vim.mapclear();
  useVimSettings.setState({ enabled: false, handlers: {} }, true);
});

function pressZ() {
  const cm = getCM(view)!;
  Vim.handleKey(cm, "<Esc>", "user");
  view.dispatch({ selection: { anchor: 2 } });
  Vim.handleKey(cm, "z", "user");
  return view.state.selection.main.head;
}

function VimSettings() {
  const form = useSettingsFormFor(VIM_SETTINGS_PAGE, "global");
  return (
    <SettingsFormContext.Provider value={form}>
      <VimSettingsPage />
    </SettingsFormContext.Provider>
  );
}

async function reloadFromSettings() {
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Reload" })));
}

it("applies changed mappings and removes old mappings when Settings reloads", async () => {
  await executeAction("vim.reloadRc");
  expect(pressZ()).toBe(0);
  render(<VimSettings />);

  rc = "nnoremap z $\nnnoremap x 0";
  await reloadFromSettings();
  expect(await screen.findByText(/2 mappings/)).toBeVisible();
  await waitFor(() => expect(pressZ()).toBe(5));

  rc = "nnoremap x 0";
  await reloadFromSettings();
  expect(await screen.findByText(/1 mappings/)).toBeVisible();
  await waitFor(() => expect(pressZ()).toBe(2));
});

it("can reload from Settings while emulation is off", async () => {
  await executeAction("vim.reloadRc");
  await executeAction("vim.toggle");
  expect(await executeAction("vim.reloadRc")).toBe(false);
  render(<VimSettings />);

  rc = "nnoremap z $\nnnoremap x 0";
  await reloadFromSettings();
  expect(await screen.findByText(/2 mappings/)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Enable Vim emulation" })).not.toBeChecked();

  await act(async () => void (await executeAction("vim.toggle")));
  expect(pressZ()).toBe(5);
});
