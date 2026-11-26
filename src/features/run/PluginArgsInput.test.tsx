import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { RunConfigCompletion } from "@/platform/ipc";
import { PluginArgsInput } from "./PluginArgsInput";
import { applyCompletion, pluginOwnedConfig } from "./pluginArgsCompletion";

afterEach(cleanup);

const item = (label: string, replaceStart: number, replaceEnd: number, insert = label): RunConfigCompletion => ({
  label,
  detail: "Taskfile.yml",
  insert,
  replaceStart,
  replaceEnd,
});

describe("applyCompletion", () => {
  it("replaces only the item's range and puts the caret after it", () => {
    expect(applyCompletion("--dry 'a b' d -- x", item("docs:serve", 12, 13))).toEqual({
      text: "--dry 'a b' docs:serve -- x",
      caret: 22,
    });
    // UTF-16 offsets, as the plugin reports them.
    expect(applyCompletion("é 😀 b", item("build", 5, 6))).toEqual({ text: "é 😀 build", caret: 10 });
    // A range past the end is clamped rather than duplicating text.
    expect(applyCompletion("b", item("build", 0, 9))).toEqual({ text: "build", caret: 5 });
  });

  it("knows a plugin's configuration, also when the user overrode it", () => {
    expect(pluginOwnedConfig({ id: "plugin:go-task:tasks", kind: "plugin" })).toBe(true);
    expect(pluginOwnedConfig({ id: "npm:dev", kind: "npm" })).toBe(false);
    expect(pluginOwnedConfig({ id: "user:1", kind: "plugin" })).toBe(false);
  });
});

function Field({
  complete,
  onKeyDown,
}: {
  complete: (id: string, text: string, caret: number) => Promise<RunConfigCompletion[]>;
  onKeyDown?: () => void;
}) {
  const [value, setValue] = useState("--dry ");
  return (
    <div onKeyDown={onKeyDown}>
      <PluginArgsInput configId="plugin:go-task:tasks" value={value} onChange={setValue} complete={complete} />
    </div>
  );
}

describe("PluginArgsInput", () => {
  it("asks the plugin as the user types and applies the chosen item", async () => {
    const complete = vi.fn(async (_id: string, text: string, caret: number) =>
      text.slice(6, caret) === "b" ? [item("build", 6, caret)] : [],
    );
    render(<Field complete={complete} />);
    const input = screen.getByRole("combobox", { name: "Arguments" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "--dry b", selectionStart: 7 } });
    expect(complete).toHaveBeenLastCalledWith("plugin:go-task:tasks", "--dry b", 7);
    await screen.findByText("build");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("--dry build");
    expect(screen.queryByText("build")).toBeNull();
  });

  it("drops an answer for text that has changed since", async () => {
    let resolveFirst: (items: RunConfigCompletion[]) => void = () => {};
    const complete = vi
      .fn()
      .mockImplementationOnce(() => new Promise<RunConfigCompletion[]>((resolve) => (resolveFirst = resolve)))
      .mockImplementation(async () => [item("test", 6, 7)]);
    render(<Field complete={complete} />);
    const input = screen.getByRole("combobox", { name: "Arguments" });
    fireEvent.change(input, { target: { value: "--dry b", selectionStart: 7 } });
    fireEvent.change(input, { target: { value: "--dry t", selectionStart: 7 } });
    await screen.findByText("test");
    await act(async () => resolveFirst([item("build", 6, 7)]));
    expect(screen.queryByText("build")).toBeNull();
    expect(screen.getByText("test")).toBeTruthy();
  });

  it("closes on Escape without leaving the field, and stays usable when the plugin answers nothing", async () => {
    const complete = vi.fn(async () => [item("build", 6, 7), item("bench", 6, 7)]);
    // The dialog around the field closes on Escape: the popup takes it first.
    const dialog = vi.fn();
    render(<Field complete={complete} onKeyDown={dialog} />);
    const input = screen.getByRole("combobox", { name: "Arguments" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "--dry b", selectionStart: 7 } });
    await screen.findByText("bench");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("bench")).toBeNull());
    expect(dialog).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(dialog).toHaveBeenCalledTimes(1);
    complete.mockResolvedValue([]);
    fireEvent.change(input, { target: { value: "--dry bx", selectionStart: 8 } });
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("--dry bx");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
