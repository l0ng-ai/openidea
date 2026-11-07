import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginInfo, UiContribution } from "@/bindings";
import { setContext, useContextKeys } from "@/platform/context";
import { useContributions, useServiceProviders } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { clearUiContributions, syncUiContributions } from "../projection";
import { defineViewUiPoints } from "../uiPoints";

const plugins = [{ id: "spring", status: "inactive" }] as PluginInfo[];
const groupId = "plugin.spring.group:framework";
const view = (id: string, extra = {}): UiContribution => ({
  pluginId: "spring",
  point: "views",
  key: id,
  decl: { id, title: id, location: "right", group: "framework", ...extra },
});
let stop: () => void;

beforeEach(() => {
  clearUiContributions();
  useContextKeys.setState({}, true);
  stop = defineViewUiPoints();
});

afterEach(() => {
  cleanup();
  clearUiContributions();
  stop();
  setPluginsBackend(null);
});

it("does not activate inactive plugins for declarations or hidden and unselected views", async () => {
  const renderView = vi.fn(async (_pluginId: string, id: string) => ({
    toolbar: [],
    body: { kind: "message" as const, value: `${id} content` },
    status: null,
  }));
  setPluginsBackend({ ...createMemoryPluginsBackend([]), renderView });
  const items = [view("routes", { when: "plugin.spring.ready" }), view("beans")];
  syncUiContributions(items, plugins);
  expect(renderView).not.toHaveBeenCalled();
  const window = useContributions.getState().toolWindows.get(groupId)!;
  render(<window.component id={groupId} />);
  expect(await screen.findByText("beans content")).toBeInTheDocument();
  expect(renderView.mock.calls.map((c) => c[1])).toEqual(["beans"]);
  act(() => setContext("plugin.spring.ready", true));
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["routes", "beans"]);
  expect(renderView.mock.calls.map((c) => c[1])).toEqual(["beans"]);
  await userEvent.click(screen.getByRole("tab", { name: "routes" }));
  expect(await screen.findByText("routes content")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "beans" }));
  expect(screen.getByText("beans content")).toBeVisible();
  expect(renderView.mock.calls.map((c) => c[1])).toEqual(["beans", "routes"]);
  act(() => syncUiContributions([], plugins));
  expect(useContributions.getState().toolWindows.has(groupId)).toBe(false);
  act(() => setContext("plugin.spring.ready", false));
  expect(useContributions.getState().toolWindows.has(groupId)).toBe(false);
});

it("keeps declaration order when a single view changes", () => {
  const items = [view("routes"), view("beans")];
  syncUiContributions(items, plugins);
  syncUiContributions([view("routes", { title: "Updated routes" }), items[1]!], plugins);
  const window = useContributions.getState().toolWindows.get(groupId)!;
  expect(window.title).toBe("Updated routes");
  // The content is loaded lazily; observing tabs must not call the plugin here.
  setPluginsBackend(createMemoryPluginsBackend([]));
  render(<window.component id={groupId} />);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Updated routes", "beans"]);
});

it("follows manifest tab reordering on reload", () => {
  setPluginsBackend(createMemoryPluginsBackend([]));
  const items = [view("routes"), view("beans")];
  syncUiContributions(items, plugins);
  syncUiContributions([...items].reverse(), plugins);
  const window = useContributions.getState().toolWindows.get(groupId)!;
  expect(window.title).toBe("beans");
  render(<window.component id={groupId} />);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["beans", "routes"]);
});

it("does not re-project existing windows when another plugin adds declarations", () => {
  const items = [view("routes"), view("beans")];
  syncUiContributions(items, plugins);
  const before = useContributions.getState().toolWindows.get(groupId);
  const other = { ...view("other"), pluginId: "other" };
  syncUiContributions([other, ...items], [...plugins, { ...plugins[0]!, id: "other" }]);
  expect(useContributions.getState().toolWindows.get(groupId)).toBe(before);
});

it("evaluates conditions on Services providers too", () => {
  syncUiContributions([view("services", { location: "services", when: "plugin.spring.ready" })], plugins);
  expect(useServiceProviders.getState().providers.has("plugin.spring.services")).toBe(false);
  setContext("plugin.spring.ready", true);
  expect(useServiceProviders.getState().providers.has("plugin.spring.services")).toBe(true);
  setContext("plugin.spring.ready", false);
  expect(useServiceProviders.getState().providers.has("plugin.spring.services")).toBe(false);
  expect(useContributions.getState().toolWindows.has(groupId)).toBe(false);
});

it("does not resurrect disposed views when asynchronous SVG loading finishes", async () => {
  let finish!: (assets: [string, string][]) => void;
  const pending = new Promise<[string, string][]>((resolve) => {
    finish = resolve;
  });
  setPluginsBackend({ ...createMemoryPluginsBackend([]), assets: () => pending });
  syncUiContributions([view("routes", { icon: "icons/routes.svg" })], plugins);
  expect(useContributions.getState().toolWindows.has(groupId)).toBe(true);
  clearUiContributions();
  finish([["viewIcon/routes", '<svg xmlns="http://www.w3.org/2000/svg"/>']]);
  await pending;
  expect(useContributions.getState().toolWindows.has(groupId)).toBe(false);
});
