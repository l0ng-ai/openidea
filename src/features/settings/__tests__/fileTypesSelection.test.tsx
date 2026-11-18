import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LanguageInfo_Serialize as LanguageInfo, Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS } from "../model/schema";
import { closeSettings, openSettings, stagedValue, useSettingsDialog } from "../model/staging";
import { RecognizedFileTypes } from "../pages/FileTypes";

function language(id: string, name: string, extension: string): LanguageInfo {
  return { id, name, extensions: [extension], uiMode: null, lineComment: null, blockComment: null, indent: null };
}

const types = () => within(screen.getByRole("listbox", { name: "Recognized file types" }));
const patternsOf = (name: string) => screen.getByRole("listbox", { name: `File name patterns of ${name}` });
const filter = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Filter file types" }), { target: { value } });

function toolbarOf(list: HTMLElement) {
  return within(screen.getAllByRole("toolbar").find((bar) => bar.getAttribute("aria-controls") === list.id)!);
}

function addPattern(list: HTMLElement, pattern: string) {
  fireEvent.click(toolbarOf(list).getByRole("button", { name: "Add" }));
  const input = within(list).getByRole("textbox", { name: "Pattern" });
  fireEvent.change(input, { target: { value: pattern } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("filtering recognized file types", () => {
  const previousProject = useProject.getState();

  beforeEach(async () => {
    const languages = [language("javascript", "JavaScript", "js"), language("python", "Python", "py")];
    mockIPC((cmd) => (cmd === "languages" ? languages : null));
    useProject.setState({ settings: structuredClone(DEFAULT_SETTINGS) as Settings, project: null });
    openSettings("editor.files");
    render(
      <PageContext.Provider value={{ pageId: "editor.files", scope: "global" }}>
        <RecognizedFileTypes />
      </PageContext.Provider>,
    );
    fireEvent.click(await types().findByRole("option", { name: "JavaScript" }));
  });

  afterEach(() => {
    cleanup();
    closeSettings();
    useProject.setState(previousProject);
    clearMocks();
  });

  it("edits only the visible language and restores the previous selection when cleared", () => {
    addPattern(patternsOf("JavaScript"), "*.example-js");

    filter("Python");
    expect(types().getByRole("option", { name: "Python", selected: true })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "File name patterns of JavaScript" })).not.toBeInTheDocument();
    const python = patternsOf("Python");
    expect(within(python).getByRole("option", { name: "*.py" })).toBeInTheDocument();
    expect(toolbarOf(python).getByRole("button", { name: "Remove" })).toBeDisabled();
    addPattern(python, "*.example-py");
    addPattern(screen.getByRole("listbox", { name: "Hashbang patterns of Python" }), "example-python");

    filter("");
    expect(types().getByRole("option", { name: /^JavaScript/, selected: true })).toBeInTheDocument();
    expect(within(patternsOf("JavaScript")).getByRole("option", { name: "*.example-js" })).toBeInTheDocument();
    expect(stagedValue(useSettingsDialog.getState(), "global", "files.fileTypes")).toEqual({
      javascript: { patterns: ["*.example-js"], removedPatterns: [], hashbangs: [] },
      python: { patterns: ["*.example-py"], removedPatterns: [], hashbangs: ["example-python"] },
    });
    expect(useProject.getState().settings?.files?.fileTypes).toEqual({});
  });

  it("hides association controls with no matches and keeps a new explicit selection", () => {
    filter("no-matching-language");
    expect(types().queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryAllByRole("listbox", { name: /patterns of/ })).toHaveLength(0);

    filter("*.py");
    fireEvent.click(types().getByRole("option", { name: "Python" }));
    filter("");
    expect(types().getByRole("option", { name: "Python", selected: true })).toBeInTheDocument();
    expect(patternsOf("Python")).toBeInTheDocument();
    expect(useSettingsDialog.getState().staged).toEqual({});
  });
});
