import { createElement } from "react";
import { cleanup as cleanupViews, render, screen } from "@testing-library/react";
import { BuildView } from "@/features/build/BuildView";
import { useBuildRun } from "@/features/build/store";
import { ConsoleModel } from "@/features/run/console";
import { ConsoleView } from "@/features/run/ConsoleView";
import { ResultsView } from "@/features/database/ResultsView";
import { useDatabase } from "@/features/database/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appActions } from "../appActions";
import { registerActions } from "@/platform/actions";
import { installKeyboardDispatcher, PRESETS, useKeymap } from "@/platform/keymap";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { installTerminalKeys } from "@/features/terminal/keys";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 20, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

const writeText = vi.fn().mockResolvedValue(undefined);
const exec = vi.fn();
let cleanup: Array<() => void> = [];

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  document.execCommand = exec;
  useKeymap.setState({ preset: "intellij-windows", overrides: {} });
  cleanup = [registerActions(appActions()), installTerminalKeys(), installKeyboardDispatcher()];
});

afterEach(() => {
  cleanupViews();
  cleanup.reverse().forEach((dispose) => dispose());
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function selectOutput(name: string, role = "log") {
  const output = document.createElement("div");
  output.role = role;
  output.tabIndex = 0;
  output.setAttribute("aria-label", name);
  output.textContent = "prefix selected application output suffix";
  document.body.append(output);
  output.addEventListener("keydown", (event) =>
    copySelectionOnKeyDown({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      nativeEvent: event,
      target: event.target!,
      currentTarget: output,
      defaultPrevented: event.defaultPrevented,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    }),
  );
  output.focus();
  const range = document.createRange();
  range.setStart(output.firstChild!, 7);
  range.setEnd(output.firstChild!, 34);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  return output;
}

function copy(target: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "c",
    code: "KeyC",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("view-local console copy with the Windows keymap (#372)", () => {
  it.each(["c", "Insert"])("copies selected Run console output with Ctrl+%s", (key) => {
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: "selected application output" });
    render(
      createElement(ConsoleView, {
        model,
        version: 1,
        softWrap: false,
        follow: false,
        onFollowChange: () => {},
        cwd: "/",
      }),
    );
    const output = screen.getByRole("log");
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("selected application output"));
    window.getSelection()!.addRange(range);
    expect(copy(output, { key, code: key === "c" ? "KeyC" : "Insert" }).defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected application output");
  });

  it.each([false, true])("copies build output and selected message detail (detail=%s)", (detail) => {
    useBuildRun.setState({
      status: "failed",
      lines: [{ kind: "err", text: "Compiler output" }],
      messages: [{ severity: "error", code: null, text: "Compiler detail", path: null, range: null }],
      selected: detail ? "build:msg:0" : null,
    });
    render(createElement(BuildView));
    const text = screen.getByText(detail ? "Compiler detail" : "Compiler output", { selector: "div" });
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.addRange(range);
    expect(copy(screen.getByRole(detail ? "document" : "log")).defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith(detail ? "Compiler detail" : "Compiler output");
  });

  it("copies selected database results output", () => {
    useDatabase.setState({ results: [], output: [{ id: 1, time: 0, kind: "info", text: "Query completed" }] });
    render(createElement(ResultsView));
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Query completed"));
    window.getSelection()!.addRange(range);
    expect(copy(screen.getByRole("log")).defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("Query completed");
  });

  it.each(["intellij-windows", "eclipse-windows", "vscode-windows"])("copies locally in %s", (preset) => {
    useKeymap.setState({ preset });
    copy(selectOutput("Build message", "document"));
    expect(writeText).toHaveBeenCalledWith("selected application output");
  });

  it("leaves editable selections to their native copy handler", () => {
    const output = selectOutput("old output");
    const input = document.createElement("input");
    output.append(input);
    input.focus();
    copy(input);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not copy a selection belonging to another output view", () => {
    const output = selectOutput("first");
    selectOutput("second");
    expect(copy(output).defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([{ altKey: true }, { shiftKey: true }, { isComposing: true }])(
    "leaves modified and composing keys alone (%j)",
    (init) => {
      expect(copy(selectOutput("Run"), init).defaultPrevented).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    },
  );

  it("does not write an empty selection", () => {
    const output = selectOutput("Run");
    window.getSelection()!.removeAllRanges();
    copy(output);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([false, true])("leaves xterm Ctrl+C to terminal handling (Shift=%s)", (shiftKey) => {
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const input = document.createElement("textarea");
    terminal.append(input);
    document.body.append(terminal);
    input.focus();
    expect(copy(input, { shiftKey }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("supports Ctrl+Insert", () => {
    expect(copy(selectOutput("Run"), { key: "Insert", code: "Insert" }).defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected application output");
  });

  it.each(Object.keys(PRESETS))("%s does not pre-empt per-view Ctrl+C", (preset) => {
    useKeymap.setState({ preset });
    expect(PRESETS[preset]?.["edit.copy"]).toBeUndefined();
    const view = document.createElement("div");
    document.body.append(view);
    const handler = vi.fn();
    view.addEventListener("keydown", handler);
    expect(copy(view).defaultPrevented).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
  });
});
