import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { commands, type Settings } from "@/platform/ipc";

const settingsSet = vi.fn();
const settingsGet = vi.fn();
const settingsGetGlobal = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      settingsSet: (...a: unknown[]) => settingsSet(...a),
      settingsGet: () => settingsGet(),
      settingsGetGlobal: () => settingsGetGlobal(),
    },
  };
});

import { registerAction, executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { useKeymap } from "@/platform/keymap";
import { ContextMenuHost } from "@/ui";
import { PageContext, useSetting } from "../components/context";
import { DEFAULT_SETTINGS, setAt } from "../model/schema";
import { openSettings, stage, useSettingsDialog } from "../model/staging";
import { SettingsDialog } from "../dialog/SettingsDialog";
import { activate } from "..";
import { MessagesHost } from "@/workbench/messages";

let current: Settings;
let dispose: () => void = () => {};

beforeEach(() => {
  current = structuredClone(DEFAULT_SETTINGS) as Settings;
  settingsSet.mockReset().mockImplementation(async (_scope: string, key: string, json: string) => {
    current = setAt(current, key, JSON.parse(json));
    return { status: "ok", data: current };
  });
  settingsGet.mockReset().mockImplementation(async () => current);
  settingsGetGlobal.mockReset().mockImplementation(async () => current);
  useProject.setState({ settings: current, project: null });
  dispose = activate();
});

afterEach(() => {
  act(() => useSettingsDialog.setState({ open: false }));
  dispose();
});

async function openDialog(page?: string) {
  render(
    <>
      <SettingsDialog />
      <MessagesHost />
    </>,
  );
  await act(async () => {
    await executeAction("file.settings", page);
  });
  return screen.getByRole("dialog", { name: "Settings" });
}

describe("Settings dialog", () => {
  it("searches pages and highlights matching option labels", async () => {
    const dialog = await openDialog("appearance");
    fireEvent.change(within(dialog).getByLabelText("Search settings"), { target: { value: "soft wrap" } });
    const tree = within(dialog).getByRole("tree", { name: "Settings pages" });
    expect(within(tree).getByText("General")).toBeInTheDocument();
    expect(within(tree).queryByText("Keymap")).toBeNull();
    // The matching page is selected and its option label is highlighted.
    const option = within(dialog).getByRole("checkbox", { name: /Soft-wrap files/ });
    expect(option.closest("[data-search-match]")).not.toBeNull();
    expect(dialog.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("Esc in the search field clears the filter first; ↓ selects the next page keeping the focus", async () => {
    const dialog = await openDialog("appearance");
    const search = within(dialog).getByLabelText("Search settings");
    fireEvent.change(search, { target: { value: "soft wrap" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    const before = useSettingsDialog.getState().pageId;
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(useSettingsDialog.getState().pageId).not.toBe(before);
    expect(document.activeElement).toBe(search);
  });

  it("stages edits and writes them on Apply", async () => {
    const dialog = await openDialog("editor.general");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Soft-wrap files/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Reformat code on save/ }));
    expect(settingsSet).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });
    expect(settingsSet.mock.calls).toEqual([
      ["global", "editor.formatOnSave", "true"],
      ["global", "editor.softWrap", "false"],
    ]);
    expect(settingsGet).toHaveBeenCalled();
    expect(useProject.getState().settings?.editor?.softWrap).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("Typography Settings weights preview live and apply as editor settings", async () => {
    const dialog = await openDialog("editor.font");
    expect(within(dialog).getByRole("button", { name: "Main font weight" })).toHaveTextContent("Regular");
    expect(within(dialog).getByRole("button", { name: "Bold font weight" })).toHaveTextContent("Bold");
    act(() => {
      stage("editor.font", "global", "editor.fontWeight", 300);
      stage("editor.font", "global", "editor.boldFontWeight", 600);
    });
    expect(within(dialog).getByRole("button", { name: "Main font weight" })).toHaveTextContent("Light");
    const preview = within(dialog).getByLabelText("Font preview");
    expect(preview.style.getPropertyValue("--fw-code")).toBe("300");
    expect(preview.style.getPropertyValue("--fw-code-bold")).toBe("600");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });
    expect(settingsSet.mock.calls).toEqual([
      ["global", "editor.boldFontWeight", "600"],
      ["global", "editor.fontWeight", "300"],
    ]);
  });

  it("edits and saves independent custom font weights", async () => {
    const dialog = await openDialog("editor.font");
    for (const [label, value] of [
      ["Main font weight", "449"],
      ["Bold font weight", "650"],
    ]) {
      fireEvent.click(within(dialog).getByRole("button", { name: label }));
      fireEvent.click(screen.getByRole("option", { name: "Custom" }));
      fireEvent.change(within(dialog).getByLabelText(`${label} custom value`), { target: { value } });
    }
    const preview = within(dialog).getByLabelText("Font preview");
    expect(preview.style.getPropertyValue("--fw-code")).toBe("450");
    expect(preview.style.getPropertyValue("--fw-code-bold")).toBe("650");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Apply" })));
    expect(settingsSet.mock.calls).toEqual([
      ["global", "editor.boldFontWeight", "650"],
      ["global", "editor.fontWeight", "450"],
    ]);
  });

  it("Cancel discards staged edits", async () => {
    const dialog = await openDialog("editor.codeStyle.other");
    fireEvent.change(within(dialog).getByLabelText("Tab size"), { target: { value: "2" } });
    expect(Object.keys(useSettingsDialog.getState().staged)).toEqual(["global|editor.tabSize"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(settingsSet).not.toHaveBeenCalled();
    expect(useSettingsDialog.getState().open).toBe(false);
  });

  it("records a shortcut, shows conflicts and applies it to the keymap on OK", async () => {
    registerAction({
      id: "code.duplicateLine",
      title: "Duplicate Line",
      category: "Code",
      when: "editorFocus",
      run: () => {},
    });
    registerAction({ id: "t.mine", title: "My Action", category: "Code", when: "editorFocus", run: () => {} });
    const dialog = await openDialog("keymap");
    const row = within(dialog).getByText("My Action");
    fireEvent.doubleClick(row);
    const recorder = await screen.findByRole("dialog", { name: /Keyboard Shortcut: My Action/ });
    const first = within(recorder).getByRole("textbox", { name: "First stroke" });
    fireEvent.keyDown(first, { code: "KeyD", key: "d", metaKey: true });
    expect(within(recorder).getByText("Duplicate Line")).toBeInTheDocument();
    fireEvent.click(within(recorder).getByRole("button", { name: "OK" }));
    const warning = await screen.findByRole("dialog", { name: "Warning" });
    expect(within(warning).getByText(/already assigned to other actions/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(warning).getByRole("button", { name: "Leave" }));
    });
    expect(useSettingsDialog.getState().staged["global|keymapOverrides"]?.value).toEqual({ "t.mine": ["Meta+D"] });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    });
    expect(settingsSet).toHaveBeenCalledWith("global", "keymapOverrides", '{"t.mine":["Meta+D"]}');
    expect(useKeymap.getState().overrides).toEqual({ "t.mine": ["Meta+D"] });
    expect(useSettingsDialog.getState().open).toBe(false);
  });

  it("duplicates the keymap from the gear menu and edits the copy", async () => {
    render(<ContextMenuHost />);
    registerAction({ id: "t.dup", title: "Dup Target", category: "Code", run: () => {} });
    const dialog = await openDialog("keymap");
    fireEvent.click(within(dialog).getByRole("button", { name: "Show Scheme Actions" }));
    fireEvent.click(await screen.findByText("Duplicate…"));
    const named = await screen.findByRole("dialog", { name: "Duplicate Keymap" });
    expect(within(named).getByRole("textbox")).toHaveValue("macOS copy");
    fireEvent.click(within(named).getByRole("button", { name: "OK" }));
    const staged = useSettingsDialog.getState().staged;
    expect(staged["global|keymap"]?.value).toBe("custom.macos-copy");
    expect(staged["global|customKeymaps"]?.value).toEqual({
      "custom.macos-copy": { name: "macOS copy", parent: "intellij-macos", overrides: {} },
    });
    fireEvent.doubleClick(within(dialog).getByText("Dup Target"));
    const recorder = await screen.findByRole("dialog", { name: /Keyboard Shortcut: Dup Target/ });
    fireEvent.keyDown(within(recorder).getByRole("textbox", { name: "First stroke" }), {
      code: "F9",
      key: "F9",
      shiftKey: true,
      altKey: true,
      metaKey: true,
      ctrlKey: true,
    });
    fireEvent.click(within(recorder).getByRole("button", { name: "OK" }));
    const after = useSettingsDialog.getState().staged;
    expect(after["global|customKeymaps"]?.value).toEqual({
      "custom.macos-copy": {
        name: "macOS copy",
        parent: "intellij-macos",
        overrides: { "t.dup": ["Ctrl+Alt+Shift+Meta+F9"] },
      },
    });
    expect(after["global|keymapOverrides"]).toBeUndefined();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    });
    expect(useKeymap.getState().preset).toBe("intellij-macos");
    expect(useKeymap.getState().overrides).toEqual({ "t.dup": ["Ctrl+Alt+Shift+Meta+F9"] });
  });

  describe("toolchain settings with a project open", () => {
    let global: Settings;
    beforeEach(() => {
      // Global layer: -Xmx1g; the project overrides it with -Xmx4g.
      global = setAt(structuredClone(DEFAULT_SETTINGS) as Settings, "languages.java.jdtlsVmArgs", "-Xmx1g");
      current = setAt(global, "languages.java.jdtlsVmArgs", "-Xmx4g");
      settingsGetGlobal.mockImplementation(async () => global);
      useProject.setState({
        settings: current,
        project: { root: "/p", name: "p", settings: current } as never,
      });
    });

    it("edit the project first; Global shows and writes the global layer", async () => {
      const dialog = await openDialog("languages.java");
      expect(within(dialog).getByRole("radio", { name: "This project" })).toHaveAttribute("aria-checked", "true");
      expect(within(dialog).getByLabelText("JVM options")).toHaveValue("-Xmx4g");

      fireEvent.click(within(dialog).getByRole("radio", { name: "Global" }));
      expect(within(dialog).getByLabelText("JVM options")).toHaveValue("-Xmx1g");
      expect(within(dialog).getByText(/used by new projects/)).toBeInTheDocument();

      fireEvent.change(within(dialog).getByLabelText("JVM options"), { target: { value: "-Xmx2g" } });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
      });
      expect(settingsSet.mock.calls).toEqual([["global", "languages.java.jdtlsVmArgs", '"-Xmx2g"']]);
    });

    it("Settings for New Projects edits the global layer on every page", async () => {
      render(<SettingsDialog />);
      await act(async () => {
        await executeAction("file.newProjectsSettings");
      });
      const dialog = screen.getByRole("dialog", { name: "Settings for New Projects" });
      expect(within(dialog).queryByRole("radiogroup", { name: "Settings scope" })).toBeNull();
      expect(within(dialog).getByLabelText("JVM options")).toHaveValue("-Xmx1g");
      expect(within(dialog).getByLabelText("Language server JDK")).toBeInTheDocument();
      expect(within(dialog).getByText(/used by new projects/)).toBeInTheDocument();
    });
  });

  it("keeps object settings stable when child keys are staged (HTTP Proxy)", async () => {
    const seen: Array<{ mode: string; host: string }> = [];
    function Probe() {
      const [proxy] = useSetting<{ mode: string; host: string }>("proxy", "global");
      seen.push(proxy);
      return <output data-testid="proxy">{`${proxy.mode}:${proxy.host}`}</output>;
    }
    openSettings("general.httpProxy");
    const view = render(
      <PageContext.Provider value={{ pageId: "general.httpProxy", scope: "global" }}>
        <Probe />
      </PageContext.Provider>,
    );
    expect(screen.getByTestId("proxy")).toHaveTextContent("auto:");
    act(() => {
      stage("general.httpProxy", "global", "proxy.mode", "manual");
      stage("general.httpProxy", "global", "proxy.host", "127.0.0.1");
    });
    expect(screen.getByTestId("proxy")).toHaveTextContent("manual:127.0.0.1");
    expect(seen.at(-1)).toMatchObject({ mode: "manual", host: "127.0.0.1" });
    view.unmount();

    const dialog = await openDialog("general.httpProxy");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Manual proxy configuration" }));
    expect(within(dialog).getByRole("radio", { name: "Manual proxy configuration" })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("Host name"), { target: { value: "127.0.0.1" } });
    expect(within(dialog).getByLabelText("Host name")).toHaveValue("127.0.0.1");
    fireEvent.click(within(dialog).getByRole("radio", { name: "No proxy" }));
    expect(within(dialog).getByRole("radio", { name: "No proxy" })).toBeChecked();
  });

  it("survives invalid settings values", async () => {
    act(() =>
      useProject.setState({
        settings: { appearance: { theme: 42, uiFontSize: "x" }, keymapOverrides: { a: "b" } } as unknown as Settings,
      }),
    );
    const dialog = await openDialog("appearance");
    expect(within(dialog).getByRole("button", { name: "Theme" })).toHaveTextContent("Islands Light");
    expect(within(dialog).getByLabelText("UI font size")).toHaveValue("13");
  });
});

describe("native Settings window background", () => {
  it.each([
    ["a hex frame", "#26282c", "", "#26282c"],
    ["an hsl() frame", "hsl(220, 13%, 15%)", "rgb(33, 37, 43)", "#21252b"],
    [
      "a translucent color-mix() frame",
      "color-mix(in srgb, #8040bf 80%, transparent)",
      "color(srgb 0.5 0.25 0.75 / 0.8)",
      "#8040bfcc",
    ],
  ])("sends %s as hex, the colour format the window command parses", async (_name, token, resolved, hex) => {
    const native = vi.spyOn(commands, "windowOpenSettings").mockResolvedValue({ status: "ok", data: null });
    const computed = vi
      .spyOn(globalThis, "getComputedStyle")
      .mockReturnValue({ getPropertyValue: () => token, color: resolved } as unknown as CSSStyleDeclaration);
    try {
      await executeAction("file.settings", "appearance");
      expect(native).toHaveBeenCalledWith("appearance", false, hex);
      expect(useSettingsDialog.getState().open).toBe(false);
    } finally {
      computed.mockRestore();
      native.mockRestore();
    }
  });
});
