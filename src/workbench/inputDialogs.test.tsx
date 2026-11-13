import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { registerAction } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { chooseItem, InputDialogsHost, pickItems, promptInput, type PromptInputOptions } from "./inputDialogs";
import { confirm, MessagesHost } from "./messages";

const background = vi.fn();
const navigate = vi.fn();
const findNext = vi.fn();
let restoreKeymap = () => {};
let dispose: (() => void)[];
let aborts: AbortController[];

function signal() {
  const abort = new AbortController();
  aborts.push(abort);
  return abort.signal;
}

function prompt(options: PromptInputOptions) {
  let result!: Promise<string | null>;
  act(() => {
    result = promptInput({ ...options, signal: signal() });
  });
  return result;
}

function press(target: Element | Window, key: string, code: string, modifiers: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, { key, code, ...modifiers });
}

beforeEach(() => {
  const keymap = useKeymap.getState();
  restoreKeymap = () => useKeymap.setState(keymap);
  aborts = [];
  background.mockClear();
  navigate.mockClear();
  findNext.mockClear();
  setContext("textEditorActive", true);
  setContext("editorTextFocus", false);
  setContext("projectOpen", true);
  dispose = [
    registerAction({
      id: "test.prompt.background",
      title: "Edit Background Query",
      when: "textEditorActive && popupOpen",
      run: background,
    }),
    registerAction({ id: "test.prompt.navigate", title: "Navigate", when: "projectOpen", run: navigate }),
    registerAction({ id: "test.prompt.findNext", title: "Next Result", when: "findPopupOpen", run: findNext }),
    installKeyboardDispatcher(window),
  ];
  useKeymap.setState({
    overrides: {
      "test.prompt.background": ["Meta+Enter", "Meta+D", "Meta+W", "Shift+Enter", "Meta+K Meta+C"],
      "test.prompt.navigate": ["Meta+J", "Shift Shift"],
      "test.prompt.findNext": ["Meta+G"],
    },
  });
  render(
    <>
      <InputDialogsHost />
      <MessagesHost />
    </>,
  );
});

afterEach(async () => {
  await act(async () => aborts.forEach((abort) => abort.abort()));
  cleanup();
  dispose.forEach((release) => release());
  restoreKeymap();
  for (const key of ["textEditorActive", "editorTextFocus", "projectOpen", "findPopupOpen"]) clearContext(key);
});

describe("blocking prompt keyboard ownership", () => {
  it("keeps editing shortcuts away from the query and submits a valid name with Cmd+Enter once", async () => {
    const result = prompt({ title: "Rename Tab", label: "Tab name:", initial: "" });
    const settled = vi.fn();
    void result.then(settled);
    const input = screen.getByRole("textbox", { name: "Tab name:" });
    expect(input).toHaveFocus();
    press(input, "Enter", "Enter", { metaKey: true });
    press(input, "d", "KeyD", { metaKey: true });
    press(input, "w", "KeyW", { metaKey: true });
    press(input, "Enter", "Enter", { shiftKey: true });
    press(input, "k", "KeyK", { metaKey: true });
    press(input, "c", "KeyC", { metaKey: true });
    const deletion = new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(deletion);
    expect(deletion.defaultPrevented).toBe(false);
    expect(background).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Customer summary" } });
    await act(async () => press(input, "Enter", "Enter", { metaKey: true }));
    await expect(result).resolves.toBe("Customer summary");
    expect(settled).toHaveBeenCalledExactlyOnceWith("Customer summary");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(background).not.toHaveBeenCalled();
  });

  it("keeps Tab, Escape and multiline Cmd+Enter local", async () => {
    const result = prompt({ title: "SQL text", multiline: true });
    const input = screen.getByRole("textbox", { name: "SQL text" });
    fireEvent.change(input, { target: { value: "SELECT 1;\nSELECT 2;" } });
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(input).toHaveFocus();
    await act(async () => press(input, "Enter", "Enter", { metaKey: true }));
    await expect(result).resolves.toBe("SELECT 1;\nSELECT 2;");
    expect(background).not.toHaveBeenCalled();
    const cancelled = prompt({ title: "Cancel this" });
    await act(async () => press(document.activeElement!, "Escape", "Escape"));
    await expect(cancelled).resolves.toBeNull();
  });

  it("retains suspension until the outer prompt closes", async () => {
    const outer = prompt({ title: "Outer", initial: "outer" });
    const inner = prompt({ title: "Inner", initial: "inner" });
    await userEvent.keyboard("{Enter}");
    await expect(inner).resolves.toBe("inner");
    const outerInput = screen.getByRole("textbox", { name: "Outer" });
    expect(outerInput).toHaveFocus();
    press(outerInput, "j", "KeyJ", { metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => press(outerInput, "Escape", "Escape"));
    await expect(outer).resolves.toBeNull();
    press(window, "j", "KeyJ", { metaKey: true });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("blocks a search popup's shortcuts during confirmation and restores them afterwards", async () => {
    setContext("findPopupOpen", true);
    press(window, "g", "KeyG", { metaKey: true });
    expect(findNext).toHaveBeenCalledOnce();
    let result!: Promise<boolean>;
    act(() => {
      result = confirm({ title: "Replace All", message: "Replace these matches?", ok: "Replace", signal: signal() });
    });
    press(document.activeElement!, "g", "KeyG", { metaKey: true });
    expect(findNext).toHaveBeenCalledOnce();
    await act(async () => press(document.activeElement!, "Enter", "Enter", { metaKey: true }));
    await expect(result).resolves.toBe(true);
    press(window, "g", "KeyG", { metaKey: true });
    expect(findNext).toHaveBeenCalledTimes(2);
  });

  it("preserves chooser navigation and Enter activation", async () => {
    let result!: Promise<string | null>;
    act(() => {
      result = chooseItem({ title: "Choose", items: ["Alpha", "Beta"] });
    });
    const list = screen.getByRole("listbox", { name: "Choose" });
    press(list, "j", "KeyJ", { metaKey: true });
    press(list, "ArrowDown", "ArrowDown");
    await act(async () => press(list, "Enter", "Enter"));
    await expect(result).resolves.toBe("Beta");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("preserves multiple-choice selection and confirmation", async () => {
    let result!: Promise<string[] | null>;
    act(() => {
      result = pickItems({
        title: "Pick",
        multiple: true,
        items: [
          { key: "a", label: "Alpha" },
          { key: "b", label: "Beta" },
        ],
        signal: signal(),
      });
    });
    const list = screen.getByRole("listbox", { name: "Pick" });
    press(list, "j", "KeyJ", { metaKey: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "OK" })));
    await expect(result).resolves.toEqual(["b"]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("suppresses double Shift during a prompt and restores it after cancellation", async () => {
    const result = prompt({ title: "Rename" });
    const doubleShift = () => {
      for (let i = 0; i < 2; i++) {
        press(window, "Shift", "ShiftLeft", { shiftKey: true });
        fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });
      }
    };
    doubleShift();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => press(document.activeElement!, "Escape", "Escape"));
    await expect(result).resolves.toBeNull();
    doubleShift();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("does not let a pending chord consume the first shortcut after mouse cancellation", async () => {
    press(window, "k", "KeyK", { metaKey: true });
    const result = prompt({ title: "Rename" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.mouseDown(cancel);
    await act(async () => fireEvent.click(cancel));
    await expect(result).resolves.toBeNull();
    press(window, "j", "KeyJ", { metaKey: true });
    expect(navigate).toHaveBeenCalledOnce();
    expect(background).not.toHaveBeenCalled();
  });

  it("restores dispatcher ownership after an externally aborted prompt", async () => {
    const result = prompt({ title: "Rename" });
    await act(async () => aborts[0]!.abort());
    await expect(result).resolves.toBeNull();
    press(window, "j", "KeyJ", { metaKey: true });
    expect(navigate).toHaveBeenCalledOnce();
  });
});
