import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS, setAt } from "../model/schema";
import { applySettings, openSettings, pendingChanges, stagedValue, useSettingsDialog } from "../model/staging";
import { GENERAL_PAGES } from "../pages/editor/general";

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: {
      ...actual.commands,
      languages: async () => [
        { id: "go", name: "Go" },
        { id: "rust", name: "Rust" },
        { id: "plaintext", name: "Plain Text" },
      ],
    },
  };
});

const PAGE = "editor.codeEditing.referenceSearch";
const KEY = "editor.codeEditing.referenceScopeDisabledLanguages";
const value = (scope: "global" | "project") => stagedValue(useSettingsDialog.getState(), scope, KEY);

beforeEach(() => {
  useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS) as Settings, project: null });
  openSettings(PAGE);
});
afterEach(cleanup);

function page(scope: "global" | "project" = "global") {
  const Page = GENERAL_PAGES.find((p) => p.id === PAGE)!.component!;
  render(
    <PageContext.Provider value={{ pageId: PAGE, scope }}>
      <Page />
    </PageContext.Provider>,
  );
}

describe("reference search scope settings", () => {
  it("defaults Go to no additional scan and other languages to additional scanning", async () => {
    page();
    expect(await screen.findByRole("checkbox", { name: "Go" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rust" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Plain Text" })).toBeNull();
  });

  it("saves language switches and restores them when settings reopen", async () => {
    page();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Go" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Rust" }));
    expect(value("global")).toEqual(["rust"]);
    expect(useProject.getState().settings?.editor?.codeEditing?.referenceScopeDisabledLanguages).toEqual(["go"]);

    let saved = structuredClone(DEFAULT_SETTINGS) as Settings;
    const set = vi.fn(async (_scope: string, key: string, json: string) => {
      saved = setAt(saved, key, JSON.parse(json));
      return saved;
    });
    await act(async () => {
      expect(
        await applySettings({
          backend: true,
          set,
          reload: async () => {
            useProject.setState({ settings: saved });
          },
          setSecret: async () => {},
        }),
      ).toBe(true);
    });
    expect(set).toHaveBeenCalledWith("global", KEY, '["rust"]');
    cleanup();
    openSettings(PAGE);
    page();
    expect(await screen.findByRole("checkbox", { name: "Go" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rust" })).not.toBeChecked();
  });

  it("stages project changes independently of global preferences", async () => {
    expect(GENERAL_PAGES.find((p) => p.id === PAGE)!.projectScope).toBe(true);
    page("project");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Go" }));
    expect(value("project")).toEqual([]);
    expect(value("global")).toEqual(["go"]);
    expect(pendingChanges(useSettingsDialog.getState())).toEqual([
      { page: PAGE, scope: "project", key: KEY, value: [] },
    ]);
  });
});
