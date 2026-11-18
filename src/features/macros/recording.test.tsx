import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { InputDialogsHost } from "@/workbench/inputDialogs";
import { MessagesHost } from "@/workbench/messages";
import { activate } from ".";
import { _reloadMacros, recordStep, saveMacro, startRecording, useMacros, type MacroStep } from "./model";

const original: MacroStep[] = [{ kind: "text", text: "original" }];
const replacement: MacroStep[] = [{ kind: "text", text: "replacement" }];
const saved = () => useMacros.getState().saved;

describe("saving a macro recording", () => {
  let dispose: () => void;

  beforeEach(() => {
    localStorage.clear();
    _reloadMacros();
    saveMacro("Example", original);
    dispose = activate();
    render(
      <>
        <InputDialogsHost />
        <MessagesHost />
      </>,
    );
    act(() => {
      startRecording();
      replacement.forEach(recordStep);
      void executeAction("macro.stopRecording");
    });
  });

  afterEach(() => {
    cleanup();
    dispose();
  });

  function nameDialog() {
    return within(screen.getByRole("dialog", { name: "Enter Macro Name" }));
  }

  async function enterName(name: string) {
    const dialog = nameDialog();
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: name } });
    await act(async () => void fireEvent.click(dialog.getByRole("button", { name: "OK" })));
  }

  it("keeps the original steps until the replacement is confirmed", async () => {
    await enterName(" Example ");
    expect(saved()).toEqual([{ name: "Example", steps: original }]);
    const prompt = within(screen.getByRole("dialog", { name: "Replace Macro?" }));
    expect(prompt.getByRole("button", { name: "Choose Another Name" })).toHaveFocus();
    await act(async () => void fireEvent.click(prompt.getByRole("button", { name: "Replace" })));
    _reloadMacros();
    expect(saved()).toEqual([{ name: "Example", steps: replacement }]);
  });

  it("can save under another name after declining to replace the original", async () => {
    await enterName("Example");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Choose Another Name" })));
    expect(nameDialog().getByRole("textbox")).toHaveValue("Example");
    await enterName("Another");
    expect(saved()).toEqual([
      { name: "Example", steps: original },
      { name: "Another", steps: replacement },
    ]);
  });

  it("cancels the save while keeping the last recording", async () => {
    await enterName("Example");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    _reloadMacros();
    expect(saved()).toEqual([{ name: "Example", steps: original }]);
    expect(useMacros.getState().last).toEqual(replacement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
