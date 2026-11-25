import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TODO_SETTINGS } from "@/platform/todo";
import { activateSettingsPages as activateTodoSettings } from "@/features/todo/settingsPages";
import { useTodoSettings } from "@/platform/todo";
import { DEFAULT_VIM_SETTINGS, useVimSettings, VIM_SETTINGS_KEY } from "@/features/vim/settings";
import { activateSettingsPages as activateVimSettings } from "@/features/vim/settingsPages";
import type { Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { SettingsDialog } from "../dialog/SettingsDialog";
import { DEFAULT_SETTINGS } from "../model/schema";
import { closeSettings, openSettings } from "../model/staging";

const TODO_SETTINGS_KEY = "openidea.todo.v1";
const dialog = () => within(screen.getByRole("dialog", { name: "Settings" }));
const button = (name: string) => dialog().getByRole("button", { name });

describe("TODO and Vim preferences in Settings", () => {
  const previousProject = useProject.getState();
  let dispose: (() => void)[];

  beforeEach(() => {
    localStorage.clear();
    useTodoSettings.setState(DEFAULT_TODO_SETTINGS, true);
    useVimSettings.setState(DEFAULT_VIM_SETTINGS, true);
    useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS) as Settings, project: null });
    dispose = [activateTodoSettings(), activateVimSettings()];
    render(<SettingsDialog />);
  });

  afterEach(() => {
    cleanup();
    closeSettings();
    dispose.forEach((off) => off());
    useProject.setState(previousProject);
  });

  it.each([
    {
      page: "editor.todo",
      label: "Only in comments",
      storage: TODO_SETTINGS_KEY,
      field: "commentsOnly",
      current: () => useTodoSettings.getState().commentsOnly,
    },
    {
      page: "editor.vim",
      label: "Enable Vim emulation",
      storage: VIM_SETTINGS_KEY,
      field: "enabled",
      current: () => useVimSettings.getState().enabled,
    },
  ])(
    "discards uncommitted $label changes on Cancel and saves on Apply",
    async ({ page, label, storage, field, current }) => {
      const initial = current();
      const open = async () => {
        act(() => openSettings(page));
        return dialog().findByRole<HTMLInputElement>("checkbox", { name: label });
      };

      fireEvent.click(await open());
      expect(button("Apply")).toBeEnabled();
      expect(current()).toBe(initial);
      expect(localStorage.getItem(storage)).toBeNull();
      fireEvent.click(button("Cancel"));

      const reopened = await open();
      expect(reopened.checked).toBe(initial);
      fireEvent.click(reopened);
      await act(async () => void fireEvent.click(button("Apply")));
      expect(current()).toBe(!initial);
      expect(JSON.parse(localStorage.getItem(storage)!)).toMatchObject({ [field]: !initial });
      expect(button("Apply")).toBeDisabled();

      fireEvent.click(reopened);
      fireEvent.click(button("Cancel"));
      expect((await open()).checked).toBe(!initial);
    },
  );

  it("stages TODO pattern edits through page Reset and OK", async () => {
    act(() => openSettings("editor.todo"));
    const add = await dialog().findByRole("button", { name: "Add Pattern" });
    fireEvent.click(add);
    expect(useTodoSettings.getState().patterns).toEqual(DEFAULT_TODO_SETTINGS.patterns);
    expect(button("Apply")).toBeEnabled();
    fireEvent.click(button("Reset"));
    expect(button("Apply")).toBeDisabled();

    fireEvent.click(add);
    const keyword = dialog().getAllByRole("textbox", { name: "Keyword" }).at(-1)!;
    fireEvent.change(keyword, { target: { value: "REVIEW" } });
    await act(async () => void fireEvent.click(button("OK")));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(useTodoSettings.getState().patterns.at(-1)?.keyword).toBe("REVIEW");
  });

  it("stages Vim conflict handlers and lets their reset clear the pending change", async () => {
    act(() => openSettings("editor.vim"));
    fireEvent.click(await dialog().findByRole("button", { name: "Handler for Escape" }));
    fireEvent.click(screen.getByRole("option", { name: "Vim" }));
    expect(button("Apply")).toBeEnabled();
    expect(useVimSettings.getState().handlers).toEqual({});
    fireEvent.click(button("Reset to Defaults"));
    expect(button("Apply")).toBeDisabled();
    expect(localStorage.getItem(VIM_SETTINGS_KEY)).toBeNull();
  });
});
