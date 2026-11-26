import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const editable = vi.hoisted(() => vi.fn());
const editArgument = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, lspEditableArguments: editable, lspEditArgument: editArgument } };
});

import type { EditableArgument } from "@/platform/ipc";
import {
  choices,
  defaultText,
  parseInput,
  shownArguments,
  shownValue,
  typeLabel,
  usePropertyEditorCaret,
} from "../flutter/propertyEditor";
import { FlutterPropertyEditorView } from "../ui/FlutterPropertyEditor";

const arg = (name: string, extra: Partial<EditableArgument>): EditableArgument => ({
  name,
  documentation: null,
  type: "string",
  value: null,
  hasArgument: false,
  defaultValue: null,
  displayValue: null,
  isRequired: false,
  isNullable: false,
  isDeprecated: false,
  isEditable: true,
  notEditableReason: null,
  options: null,
  ...extra,
});

const align = arg("textAlign", {
  type: "enum",
  isNullable: true,
  options: ["TextAlign.left", "TextAlign.center"],
  defaultValue: "TextAlign.left",
});

describe("Flutter Property Editor arguments", () => {
  it("shows values and types as DevTools does", () => {
    expect(typeLabel(align)).toBe("TextAlign?");
    expect(typeLabel(arg("data", {}))).toBe("String");
    expect(shownValue({ ...align, hasArgument: true, value: "TextAlign.center" })).toBe(".center");
    expect(shownValue(arg("x", { hasArgument: true }))).toBe("null");
    expect(shownValue(arg("x", { type: "double", hasArgument: true, displayValue: "kPad * 2" }))).toBe("kPad * 2");
    expect(shownValue(align)).toBe("");
    expect(defaultText(align)).toBe(".left");
    const deprecated = arg("old", { isDeprecated: true });
    expect(shownArguments([deprecated, { ...deprecated, name: "set", hasArgument: true }]).map((a) => a.name)).toEqual([
      "set",
    ]);
  });

  it("offers a bool's or enum's values, with the expression the code passes", () => {
    expect(choices(arg("x", { type: "bool" }))).toEqual(["true", "false"]);
    expect(choices({ ...align, hasArgument: true, displayValue: "myAlign" })).toEqual([
      ".left",
      ".center",
      "myAlign",
      "null",
    ]);
    expect(choices(arg("x", { type: "int" }))).toBeNull();
  });

  it("sends only values of the parameter's type", () => {
    const int = arg("n", { type: "int" });
    expect(parseInput(int, " 3 ")).toEqual({ value: 3 });
    expect(parseInput(int, "3.5")).toBeUndefined();
    expect(parseInput(int, "")).toBeUndefined();
    expect(parseInput({ ...int, isNullable: true }, "")).toEqual({ value: null });
    expect(parseInput(arg("d", { type: "double" }), "8.5")).toEqual({ value: 8.5 });
    expect(parseInput(arg("s", {}), " a ")).toEqual({ value: " a " });
    expect(parseInput(arg("b", { type: "bool" }), "false")).toEqual({ value: false });
    expect(parseInput(align, ".center")).toEqual({ value: "TextAlign.center" });
    expect(parseInput(align, "null")).toEqual({ value: null });
    expect(parseInput(align, ".right")).toBeUndefined();
  });
});

describe("Flutter Property Editor window", () => {
  const caret = (line: number, col: number) => ({ doc: 7, pos: { line, col }, synced: () => Promise.resolve() });
  beforeEach(() => {
    editable.mockReset();
    editArgument.mockReset().mockResolvedValue({ status: "ok", data: null });
  });
  afterEach(() => {
    cleanup();
    usePropertyEditorCaret.setState({ caret: null });
  });

  it("lists the arguments at the caret and applies an edit on Enter", async () => {
    editable.mockResolvedValue({
      status: "ok",
      data: {
        name: "Text",
        documentation: "Creates a text widget.\n\nMore.",
        arguments: [
          arg("data", { hasArgument: true, value: "Hello", isRequired: true }),
          arg("maxLines", { type: "int", isNullable: true }),
        ],
      },
    });
    render(<FlutterPropertyEditorView />);
    screen.getByText("Open a Dart file to edit widget arguments");
    act(() => usePropertyEditorCaret.setState({ caret: caret(3, 10) }));
    const data = await screen.findByDisplayValue("Hello");
    expect(editable).toHaveBeenCalledWith(7, { line: 3, col: 10 });
    screen.getByText("Creates a text widget.");

    const lines = screen.getByLabelText(/maxLines/);
    fireEvent.change(lines, { target: { value: "two" } });
    expect(lines.getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(lines, { key: "Enter" });
    expect(editArgument).not.toHaveBeenCalled();

    fireEvent.change(data, { target: { value: "Bye" } });
    fireEvent.keyDown(data, { key: "Enter" });
    expect(editArgument).toHaveBeenCalledWith(7, { line: 3, col: 10 }, "data", "Bye");
  });

  it("says when the caret isn't in a call", async () => {
    editable.mockResolvedValue({ status: "ok", data: null });
    render(<FlutterPropertyEditorView />);
    act(() => usePropertyEditorCaret.setState({ caret: caret(0, 0) }));
    await waitFor(() => screen.getByText("Place the caret in a widget constructor call to edit its arguments"));
  });
});
