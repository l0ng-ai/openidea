import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectInfo, ServiceTab, View } from "@/bindings";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { ToolWindowShownProvider, useContributions } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { PluginView } from "../views/PluginView";
import { ServicePane } from "../views/ServicePane";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, syncUiContributions } from "../projection";
import { bumpView } from "../views/viewStore";

const originalProject = useProject.getState().project;
const originalRemote = useRemote.getState().session;
afterEach(() => {
  setPluginsBackend(null);
  act(() => {
    useProject.setState({ project: originalProject });
    useRemote.setState({ session: originalRemote });
  });
});
const select = (key: string) => {
  const row = screen.getByText(key);
  fireEvent.mouseDown(row, { button: 0 });
  fireEvent.click(row);
};
const tabs = (key: string): ServiceTab[] => [
  { id: "info", label: "Info", body: { kind: "text", value: `Details ${key}` } },
];
const item = (key: string) => ({
  key,
  label: key,
  icon: null,
  detail: null,
  parent: null,
  expandable: false,
  expanded: false,
});

function setup(kind: "tree" | "list") {
  let keys = ["a", "b"];
  const b = {
    ...createMemoryPluginsBackend([]),
    renderView: vi.fn(async (): Promise<View> => ({
      toolbar: [],
      status: null,
      body: { kind, value: keys.map(item) },
    })),
    viewEvent: vi.fn(async () => {}),
    serviceDetail: vi.fn(async (_p: string, _v: string, key: string) => tabs(key)),
  };
  setPluginsBackend(b);
  return {
    b,
    remove: () => {
      keys = ["b"];
      bumpView("p", kind);
    },
  };
}

describe("detail views", () => {
  it.each(["tree", "list"] as const)("follows %s selection and clears removed items", async (kind) => {
    const { b, remove } = setup(kind);
    render(<PluginView pluginId="p" view={kind} detail />);
    await screen.findByText("a");
    select("a");
    expect(await screen.findByRole("document")).toHaveTextContent("Details a");
    select("b");
    await waitFor(() => expect(screen.getByRole("document")).toHaveTextContent("Details b"));
    expect(b.serviceDetail).toHaveBeenLastCalledWith("p", kind, "b");
    select("a");
    await waitFor(() => expect(screen.getByRole("document")).toHaveTextContent("Details a"));
    act(remove);
    expect(await screen.findByText("Select an item to view details")).toBeTruthy();
    expect(screen.queryByRole("document")).toBeNull();
  });

  it("waits for the select handler before requesting details", async () => {
    const { b } = setup("list");
    let finish = () => {};
    b.viewEvent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PluginView pluginId="p" view="list" detail />);
    await screen.findByText("a");
    select("a");
    await waitFor(() => expect(b.viewEvent).toHaveBeenCalled());
    expect(b.serviceDetail).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(await screen.findByRole("document")).toHaveTextContent("Details a");
  });

  it.each(["tree", "list"] as const)("updates %s details on keyboard selection", async (kind) => {
    const { b } = setup(kind);
    render(<PluginView pluginId="p" view={kind} detail />);
    await screen.findByText("a");
    select("a");
    await screen.findByRole("document");
    const row = screen.getByText("a").closest('[role="treeitem"], [role="option"]')!;
    fireEvent.keyDown(row, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("document")).toHaveTextContent("Details b"));
    expect(b.serviceDetail).toHaveBeenLastCalledWith("p", kind, "b");
  });

  it("keeps ordinary bodies unchanged and does not request details without opt-in", async () => {
    const { b } = setup("list");
    render(<PluginView pluginId="p" view="plain" />);
    await screen.findByText("a");
    select("a");
    await waitFor(() => expect(b.viewEvent).toHaveBeenCalled());
    expect(screen.queryByRole("separator")).toBeNull();
    expect(b.serviceDetail).not.toHaveBeenCalled();
  });

  it("ignores late detail responses after the selected item changes", async () => {
    let resolveA = (_tabs: ServiceTab[]) => {};
    const b = {
      ...createMemoryPluginsBackend([]),
      serviceDetail: vi.fn(async (_p: string, _v: string, key: string) =>
        key === "a"
          ? new Promise<ServiceTab[]>((resolve) => {
              resolveA = resolve;
            })
          : tabs(key),
      ),
    };
    setPluginsBackend(b);
    const ui = render(<ServicePane pluginId="p" view="v" itemKey="a" />);
    await waitFor(() => expect(b.serviceDetail).toHaveBeenCalled());
    ui.rerender(<ServicePane pluginId="p" view="v" itemKey="b" />);
    expect(await screen.findByRole("document")).toHaveTextContent("Details b");
    await act(async () => resolveA(tabs("a")));
    expect(screen.getByRole("document")).toHaveTextContent("Details b");
  });

  it("stops the previous item's log immediately on selection change", async () => {
    const stop = vi.fn();
    setPluginsBackend({
      ...createMemoryPluginsBackend([]),
      serviceDetail: async (_p, _v, key) =>
        key === "a"
          ? [{ id: "log", label: "Log", body: { kind: "log", value: { program: "sh", args: [], toggles: [] } } }]
          : new Promise(() => {}),
      serviceLog: () => stop,
    });
    const ui = render(<ServicePane pluginId="p" view="v" itemKey="a" />);
    await screen.findByRole("tab", { name: "Log" });
    ui.rerender(<ServicePane pluginId="p" view="v" itemKey="b" />);
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

it("retries details after an error and refresh", async () => {
  let fail = true;
  setPluginsBackend({
    ...createMemoryPluginsBackend([]),
    serviceDetail: async () => {
      if (fail) throw new Error("offline");
      return tabs("a");
    },
  });
  render(<ServicePane pluginId="p" view="retry" itemKey="a" />);
  await screen.findByText("offline");
  fail = false;
  act(() => bumpView("p", "retry"));
  expect(await screen.findByRole("document")).toHaveTextContent("Details a");
});

it("clears selection and cancels a log when the project changes", async () => {
  const { b } = setup("list");
  const stop = vi.fn();
  setPluginsBackend({
    ...b,
    serviceDetail: async () => [
      { id: "log", label: "Log", body: { kind: "log", value: { program: "sh", args: [], toggles: [] } } },
    ],
    serviceLog: () => stop,
  });
  render(<PluginView pluginId="p" view="list" detail />);
  await screen.findByText("a");
  select("a");
  await screen.findByRole("tab", { name: "Log" });
  act(() => useProject.setState({ project: { root: "/other" } as ProjectInfo }));
  expect(stop).toHaveBeenCalledOnce();
  expect(await screen.findByText("Select an item to view details")).toBeTruthy();
  expect(screen.queryByRole("tab")).toBeNull();
});

it("stops logs while a kept-alive tool window is hidden and reloads on show", async () => {
  const stop = vi.fn();
  const serviceDetail = vi.fn(async (): Promise<ServiceTab[]> => [
    { id: "log", label: "Log", body: { kind: "log", value: { program: "sh", args: [], toggles: [] } } },
  ]);
  setPluginsBackend({ ...createMemoryPluginsBackend([]), serviceDetail, serviceLog: () => stop });
  const view = (shown: boolean) => (
    <ToolWindowShownProvider value={shown}>
      <ServicePane pluginId="p" view="hidden" itemKey="a" />
    </ToolWindowShownProvider>
  );
  const ui = render(view(true));
  await screen.findByRole("tab", { name: "Log" });
  ui.rerender(view(false));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.queryByRole("tab")).toBeNull();
  ui.rerender(view(true));
  await screen.findByRole("tab", { name: "Log" });
  expect(serviceDetail).toHaveBeenCalledTimes(2);
});

it.each(["left", "right", "bottom"].flatMap((location) => [null, "items"].map((group) => ({ location, group }))))(
  "projects detail declarations in $location with group=$group",
  async ({ location, group }) => {
    const undefine = defineBuiltinUiPoints();
    const { b } = setup("list");
    try {
      syncUiContributions(
        [
          {
            pluginId: "p",
            point: "views",
            key: "list",
            decl: { id: "list", title: "Items", location, group, detail: true },
          },
        ],
        [{ id: "p", name: "P", enabled: true, status: "active" } as Parameters<typeof syncUiContributions>[1][number]],
      );
      const contribution = useContributions
        .getState()
        .toolWindows.get(group ? `plugin.p.group:${group}` : "plugin.p.list")!;
      expect(contribution.anchor).toBe(location);
      const Component = contribution.component;
      render(<Component id={contribution.id} />);
      await screen.findByText("a");
      select("a");
      expect(await screen.findByRole("document")).toHaveTextContent("Details a");
      expect(b.serviceDetail).toHaveBeenCalledWith("p", "list", "a");
    } finally {
      clearUiContributions();
      undefine();
    }
  },
);

it("drops queued events when their project/view has been left", async () => {
  const { b } = setup("list");
  let finish = () => {};
  b.viewEvent.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<PluginView pluginId="p" view="list" detail />);
  await screen.findByText("a");
  select("a");
  await waitFor(() => expect(b.viewEvent).toHaveBeenCalledOnce());
  select("b");
  act(() => useProject.setState({ project: { root: "/next" } as ProjectInfo }));
  await act(async () => finish());
  expect(b.viewEvent).toHaveBeenCalledOnce();
  expect(b.serviceDetail).not.toHaveBeenCalled();
});

it("clears detail when remote hosts use the same project path", async () => {
  setup("list");
  const session = (config: string) => ({
    target: { kind: "ssh" as const, config },
    root: "/same",
    host: config,
    os: "linux",
    commands: [],
  });
  act(() => {
    useProject.setState({ project: { root: "/same" } as ProjectInfo });
    useRemote.setState({ session: session("one") });
  });
  render(<PluginView pluginId="p" view="list" detail />);
  await screen.findByText("a");
  select("a");
  await screen.findByRole("document");
  act(() => useRemote.setState({ session: session("two") }));
  expect(await screen.findByText("Select an item to view details")).toBeTruthy();
  expect(screen.queryByRole("document")).toBeNull();
});
