import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "@/platform/actions";
import { CLEAR_COLOR } from "@/platform/colorScheme";
import { setLocale } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, stage, stagedValue, useSettingsDialog } from "../model/staging";
import { PageContext } from "../components/context";
import { COLOR_SCHEME_PAGES } from "../pages/editor/colorScheme";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@/workbench/messages", () => ({ ask: mocks.ask, confirm: mocks.confirm, showError: mocks.error }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, fsReadText: mocks.read, fsCreateFileBytes: mocks.write } };
});
const value = (key: string) => stagedValue(useSettingsDialog.getState(), "global", `editor.${key}`);
const run = (name: string) =>
  act(async () => {
    await executeAction(`editor.colorScheme.${name}`);
  });
const schemePage = (id: string) => {
  const page = COLOR_SCHEME_PAGES.find((p) => p.id === id)!;
  const Page = page.component!;
  render(
    <PageContext.Provider value={{ pageId: page.id, scope: "project" }}>
      <Page />
    </PageContext.Provider>,
  );
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue("/schemes/forest.icls");
  mocks.save.mockResolvedValue("/schemes/export.icls");
  mocks.read.mockResolvedValue({
    status: "ok",
    data: readFileSync("src/platform/__fixtures__/colorSchemes/forest.icls", "utf8"),
  });
  mocks.write.mockResolvedValue({ status: "ok", data: null });
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS), project: null });
  openSettings("editor.colorScheme");
});

describe("scheme actions", () => {
  beforeEach(() => schemePage("editor.colorScheme"));
  it("imports and selects in global scope, exports and confirms deletion", async () => {
    await run("import");
    const id = value("colorScheme") as string;
    expect(id).toMatch(/^custom-/);
    expect(screen.getByRole("status")).toHaveTextContent("Applied 16 values; skipped 2");
    expect(Object.values(useSettingsDialog.getState().staged).every((s) => s.scope === "global")).toBe(true);
    await run("export");
    expect(mocks.write).toHaveBeenCalledWith("/schemes/export.icls", expect.any(Array));
    expect(new TextDecoder().decode(new Uint8Array(mocks.write.mock.calls[0]![1]))).toContain(
      'name="Forest &amp; Moss"',
    );
    mocks.confirm.mockResolvedValueOnce(false);
    await run("delete");
    expect(value("colorScheme")).toBe(id);
    mocks.confirm.mockResolvedValueOnce(true);
    await run("delete");
    expect(value("colorScheme")).toBe("theme-default");
    expect(value("customSchemes")).toEqual({});
  });

  it("accepts file paths from action callers and keeps the same import/export flow", async () => {
    await act(async () => {
      await executeAction("editor.colorScheme.import", "/chosen/custom.icls");
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledWith("/chosen/custom.icls");
    expect(value("colorScheme")).toMatch(/^custom-/);
    await act(async () => {
      await executeAction("editor.colorScheme.export", "/chosen/custom-export.icls");
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith("/chosen/custom-export.icls", expect.any(Array));
  });

  it("supports cancel, keep both and overwrite collisions", async () => {
    await run("import");
    const first = value("colorScheme");
    mocks.ask.mockResolvedValueOnce({ button: "cancel" });
    await run("import");
    expect(value("colorScheme")).toBe(first);
    mocks.ask.mockResolvedValueOnce({ button: "both" });
    await run("import");
    expect(Object.values(value("customSchemes") as Record<string, { name: string }>).map((s) => s.name)).toEqual([
      "Forest & Moss",
      "Forest & Moss (2)",
    ]);
    act(() =>
      stage("editor.colorScheme", "global", "editor.colorOverrides", {
        [first as string]: { keyword: { foreground: "#ff0000" } },
      }),
    );
    mocks.ask.mockResolvedValueOnce({ button: "overwrite" });
    await run("import");
    expect(value("colorScheme")).toBe(first);
    expect(value("colorOverrides")).toEqual({});
    expect(Object.keys(value("customSchemes") as object)).toHaveLength(2);
  });

  it("shows a malformed-file error without staging any changes", async () => {
    mocks.read.mockResolvedValueOnce({ status: "ok", data: '<scheme name="bad">' });
    await run("import");
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Color Scheme", "Invalid .icls color scheme"));
    expect(useSettingsDialog.getState().staged).toEqual({});
  });
});

describe("Go scheme attributes", () => {
  it("translates the attribute tree and preview selection in Chinese", async () => {
    await act(async () => {
      await setLocale("zh");
    });
    try {
      schemePage("editor.colorScheme.go");
      expect(screen.getByRole("treeitem", { name: "标识符" })).toBeInTheDocument();
      const preview = screen.getByLabelText("配色方案预览");
      act(() => fireEvent.click(within(preview).getByText("fmt")));
      expect(screen.getByRole("treeitem", { name: "包引用" })).toHaveAttribute("aria-selected", "true");
    } finally {
      await act(async () => {
        await setLocale("en");
      });
    }
  });

  it("selects package references from the preview, inherits defaults and restores overrides", () => {
    act(() => {
      stage("editor.colorScheme", "global", "editor.colorScheme", "dark");
      stage("editor.colorScheme", "global", "editor.colorOverrides", {
        dark: { packageReference: { foreground: "#139839" } },
      });
    });
    schemePage("editor.colorScheme.go");
    const preview = screen.getByLabelText("Color scheme preview");
    act(() => fireEvent.click(within(preview).getByText("fmt")));
    expect(screen.getByRole("treeitem", { name: "Package reference" })).toHaveAttribute("aria-selected", "true");
    expect(preview.style.getPropertyValue("--syn-namespace")).toBe("#139839");

    act(() => fireEvent.click(screen.getByRole("checkbox", { name: "Bold" })));
    expect(value("colorOverrides")).toEqual({
      dark: { packageReference: { foreground: "#139839" }, "go.packageReference": { bold: true } },
    });
    expect(preview.style.getPropertyValue("--syn-namespace-bold")).toBe("var(--fw-code-bold, 700)");

    act(() => fireEvent.click(screen.getByRole("button", { name: "Restore Defaults" })));
    expect(value("colorOverrides")).toEqual({});
    expect(screen.getByRole("checkbox", { name: "Bold" })).not.toBeChecked();
  });
});

describe("scheme attribute state", () => {
  beforeEach(() => schemePage("editor.colorScheme.language-defaults"));
  it("shows checked attributes and inherited colours from the selected scheme", () => {
    act(() => {
      stage("editor.colorScheme", "global", "editor.customSchemes", {
        "custom-test": {
          name: "Test",
          parent: "dark",
          attributes: {
            keyword: {
              foreground: "#139839",
              bold: true,
              italic: false,
              effect: "wave",
              effectColor: "#abcdef",
            },
          },
        },
      });
      stage("editor.colorScheme", "global", "editor.colorScheme", "custom-test");
    });

    expect(screen.getByRole("checkbox", { name: "Bold" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Italic" })).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "Foreground hex" })).toHaveValue("#139839");
    expect(screen.queryByRole("textbox", { name: "Background hex" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Effects" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Effect" })).toHaveTextContent("Underwaved");
    expect(screen.getByRole("textbox", { name: "Effect color hex" })).toHaveValue("#abcdef");
  });

  it("selects an empty background and clears it back to the scheme state", () => {
    const background = screen.getByRole("checkbox", { name: "Background" });
    act(() => fireEvent.click(background));

    expect(background).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Background hex" })).toHaveValue("#808080");
    expect(Object.values(value("colorOverrides") as object)).toEqual([{ keyword: { background: "#808080" } }]);

    act(() => fireEvent.click(background));

    expect(background).not.toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Background hex" })).not.toBeInTheDocument();
    expect(value("colorOverrides")).toEqual({});
    expect(useSettingsDialog.getState().staged["global|editor.colorOverrides"]).toBeUndefined();
  });

  it("clears a background inherited from the selected scheme", () => {
    act(() => {
      stage("editor.colorScheme", "global", "editor.customSchemes", {
        "custom-test": {
          name: "Test",
          parent: "dark",
          attributes: { keyword: { background: "#2b2d30" } },
        },
      });
      stage("editor.colorScheme", "global", "editor.colorScheme", "custom-test");
    });

    const background = screen.getByRole("checkbox", { name: "Background" });
    expect(background).toBeChecked();
    expect(background).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Background hex" })).toHaveValue("#2b2d30");

    act(() => fireEvent.click(background));
    expect(background).not.toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Background hex" })).not.toBeInTheDocument();
    expect(Object.values(value("colorOverrides") as object)).toEqual([{ keyword: { background: CLEAR_COLOR } }]);

    act(() => fireEvent.click(background));
    expect(background).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Background hex" })).toHaveValue("#2b2d30");
    expect(value("colorOverrides")).toEqual({});
  });

  it("removes an effect override when the scheme value is selected again", () => {
    act(() => {
      stage("editor.colorScheme", "global", "editor.customSchemes", {
        "custom-test": {
          name: "Test",
          parent: "dark",
          attributes: { keyword: { effect: "wave", effectColor: "#abcdef" } },
        },
      });
      stage("editor.colorScheme", "global", "editor.colorScheme", "custom-test");
    });

    const effects = screen.getByRole("checkbox", { name: "Effects" });
    act(() => fireEvent.click(effects));
    expect(value("colorOverrides")).not.toEqual({});

    act(() => fireEvent.click(effects));
    expect(effects).toBeChecked();
    expect(value("colorOverrides")).toEqual({});
    expect(useSettingsDialog.getState().staged["global|editor.colorOverrides"]).toBeUndefined();
  });

  it("clears a newly selected effect back to an unmodified state", () => {
    const effects = screen.getByRole("checkbox", { name: "Effects" });
    expect(effects).not.toBeChecked();

    act(() => fireEvent.click(effects));
    expect(effects).toBeChecked();
    expect(value("colorOverrides")).not.toEqual({});

    act(() => fireEvent.click(effects));
    expect(effects).not.toBeChecked();
    expect(value("colorOverrides")).toEqual({});
    expect(useSettingsDialog.getState().staged["global|editor.colorOverrides"]).toBeUndefined();
  });
});
