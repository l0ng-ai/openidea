import { readFileSync } from "node:fs";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, stage, stagedValue, useSettingsDialog } from "../model/staging";
import { PageContext } from "../components/context";
import { COLOR_SCHEME_PAGE } from "../pages/editor/colorScheme";

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
  const Page = COLOR_SCHEME_PAGE.component!;
  render(
    <PageContext.Provider value={{ pageId: "editor.colorScheme", scope: "project" }}>
      <Page />
    </PageContext.Provider>,
  );
});

describe("scheme actions", () => {
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
