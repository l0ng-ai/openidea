import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Settings } from "@/platform/ipc";

const settingsSet = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, settingsSet: (...a: unknown[]) => settingsSet(...a) },
  };
});

import { useProject } from "@/platform/project";
import { ContextMenuHost } from "@/ui";
import { registerStatusItem, type StatusItemContribution } from "./contributions";
import { StatusBar } from "./StatusBar";
import { isStatusItemVisible, statusBarMenu } from "./statusBarWidgets";
import { executeAction } from "@/platform/actions";
import { registerShellActions } from "./shellActions";

const item = (id: string, extra: Partial<StatusItemContribution> = {}): StatusItemContribution => ({
  id,
  align: "right",
  priority: 0,
  component: () => <span>{id}</span>,
  ...extra,
});

let widgets: Record<string, boolean>;
let disposers: Array<() => void> = [];

beforeEach(() => {
  widgets = {};
  const settings = () => ({ appearance: { statusBarWidgets: { ...widgets } } }) as unknown as Settings;
  useProject.setState({ settings: settings() });
  settingsSet.mockReset().mockImplementation(async (_scope: string, key: string, json: string) => {
    expect(key).toBe("appearance.statusBarWidgets");
    widgets = JSON.parse(json);
    return { status: "ok", data: settings() };
  });
});

afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  useProject.setState({ settings: null });
});

describe("status bar widgets", () => {
  it("applies defaults and overrides", () => {
    const memory = { id: "perf.memory", title: "Memory Indicator", defaultVisible: false };
    expect(isStatusItemVisible(memory, undefined)).toBe(false);
    expect(isStatusItemVisible(memory, { "perf.memory": true })).toBe(true);
    expect(isStatusItemVisible({ id: "caret", title: "Line:Column" }, {})).toBe(true);
    expect(isStatusItemVisible({ id: "caret", title: "Line:Column" }, { caret: false })).toBe(false);
    // Untitled widgets cannot be hidden.
    expect(isStatusItemVisible({ id: "tasks" }, { tasks: false })).toBe(true);
  });

  it("lists titled widgets with checkmarks", () => {
    const set = vi.fn();
    const menu = statusBarMenu(
      [
        item("caret", { title: "Line:Column Number" }),
        item("tasks"),
        item("mem", { title: "Memory", defaultVisible: false }),
      ],
      { caret: true },
      set,
    );
    expect(menu.map((m) => ("label" in m ? [m.label, "checked" in m && m.checked] : null))).toEqual([
      ["Line:Column Number", true],
      ["Memory", false],
    ]);
    const mem = menu[1]!;
    if ("run" in mem && mem.run) mem.run();
    expect(set).toHaveBeenCalledWith("mem", true);
  });

  it("toggles a widget from the status bar context menu and persists it", async () => {
    disposers.push(
      registerStatusItem(item("w.caret", { title: "Line:Column Number", priority: 1 })),
      registerStatusItem(item("w.memory", { title: "Memory Indicator", defaultVisible: false, priority: 2 })),
    );
    render(
      <>
        <StatusBar />
        <ContextMenuHost />
      </>,
    );
    expect(screen.queryByText("w.memory")).toBeNull();
    expect(screen.getByText("w.caret")).toBeTruthy();

    fireEvent.contextMenu(screen.getByLabelText("Status bar"), { clientX: 10, clientY: 10 });
    const entry = await screen.findByRole("menuitemcheckbox", { name: /Memory Indicator/ });
    expect(entry.getAttribute("aria-checked")).toBe("false");
    await act(async () => void fireEvent.click(entry));

    expect(settingsSet).toHaveBeenCalledWith(
      "global",
      "appearance.statusBarWidgets",
      JSON.stringify({ "w.memory": true }),
    );
    expect(await screen.findByText("w.memory")).toBeTruthy();
  });

  it("toggles one widget by id from View › Appearance › Status Bar Widgets", async () => {
    disposers.push(
      registerShellActions(),
      registerStatusItem(item("w.caret", { title: "Line:Column Number" })),
      registerStatusItem(item("w.memory", { title: "Memory Indicator", defaultVisible: false })),
      registerStatusItem(item("w.tasks")),
    );
    await act(() => executeAction("view.toggleStatusBarWidget", "w.memory"));
    expect(settingsSet).toHaveBeenLastCalledWith(
      "global",
      "appearance.statusBarWidgets",
      JSON.stringify({ "w.memory": true }),
    );
    await act(() => executeAction("view.toggleStatusBarWidget", "w.caret"));
    expect(widgets).toEqual({ "w.memory": true, "w.caret": false });
    // Untitled or unknown widgets cannot be hidden.
    await act(() => executeAction("view.toggleStatusBarWidget", "w.tasks"));
    await act(() => executeAction("view.toggleStatusBarWidget", "w.gone"));
    expect(settingsSet).toHaveBeenCalledTimes(2);
  });
});
