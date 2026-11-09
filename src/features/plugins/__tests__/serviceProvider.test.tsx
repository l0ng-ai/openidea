import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ProjectInfo, View, ViewEvent, ViewTreeItem } from "@/bindings";
import { serviceProviders, type ServiceTreeItem } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, syncUiContributions } from "../projection";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { pluginServiceProvider } from "../views/serviceProvider";

let undefinePoints: () => void = () => {};
const originalProject = useProject.getState().project;
const originalRemote = useRemote.getState().session;

beforeEach(() => {
  undefinePoints = defineBuiltinUiPoints();
});

afterEach(() => {
  clearUiContributions();
  undefinePoints();
  setPluginsBackend(null);
  act(() => {
    useProject.setState({ project: originalProject });
    useRemote.setState({ session: originalRemote });
  });
});

const item = (key: string, label: string, parent: string | null = null): ViewTreeItem => ({
  key,
  parent,
  label,
  icon: "folder",
  detail: null,
  expandable: false,
  expanded: false,
});

const pods: View = {
  toolbar: [{ id: "delete", label: "Delete", icon: "trash", enabled: true }],
  status: null,
  body: {
    kind: "tree",
    value: [item("ctx", "minikube"), item("ns", "default", "ctx"), item("pod:default/nginx", "nginx", "ns")],
  },
};

function backend(view: View = pods) {
  const events: [string, string, ViewEvent][] = [];
  const b: PluginsBackend = {
    ...createMemoryPluginsBackend([]),
    renderView: vi.fn(async () => view),
    viewEvent: vi.fn(async (pluginId: string, v: string, e: ViewEvent) => void events.push([pluginId, v, e])),
  };
  setPluginsBackend(b);
  return { b, events };
}

const decl = { id: "kube", title: "Kubernetes", location: "services" as const };

const noMenu = () => [];

async function roots(pluginId: string) {
  const provider = pluginServiceProvider(pluginId, decl, "plugin", noMenu);
  const { result } = renderHook(() => provider.useRoots());
  await waitFor(() => expect(result.current).not.toHaveLength(0));
  return { provider, roots: result.current };
}

const keys = (items: ServiceTreeItem[]): unknown =>
  items.map((i) => (i.children ? { [i.key]: keys(i.children) } : i.key));

describe("plugin service providers", () => {
  it("maps the plugin tree to service nodes", async () => {
    backend();
    const { roots: nodes } = await roots("p");
    expect(keys(nodes)).toEqual([
      { "plugin:p/kube/ctx": [{ "plugin:p/kube/ns": ["plugin:p/kube/pod:default/nginx"] }] },
    ]);
    expect(nodes[0]?.label).toBe("minikube");
  });

  it("maps a list to Services nodes without another split", async () => {
    backend({
      toolbar: [],
      status: null,
      body: { kind: "list", value: [{ key: "a", label: "Alpha", icon: null, detail: "ready" }] },
    });
    const { roots: nodes } = await roots("p");
    expect(nodes).toEqual([expect.objectContaining({ key: "plugin:p/kube/a", label: "Alpha", detail: "ready" })]);
    expect(nodes[0]?.children).toBeUndefined();
  });

  it("routes events with the raw key", async () => {
    const { events } = backend();
    const { provider, roots: nodes } = await roots("p");
    const nginx = nodes[0]!.children![0]!.children![0]!;
    provider.select?.(nginx);
    await waitFor(() => expect(events).toContainEqual(["p", "kube", { kind: "select", key: "pod:default/nginx" }]));
    provider.activate?.(nginx);
    await waitFor(() => expect(events).toContainEqual(["p", "kube", { kind: "activate", key: "pod:default/nginx" }]));
    const actions = provider.actions?.(nginx) ?? [];
    expect(actions[0]?.id).not.toBe(provider.actions?.(nodes[0]!)[0]?.id);
    actions[0]?.run();
    await waitFor(() => expect(events).toContainEqual(["p", "kube", { kind: "button", id: "delete" }]));
    const select = events.findIndex(([, , e]) => e.kind === "select" && e.key === "pod:default/nginx");
    const button = events.findIndex(([, , e]) => e.kind === "button");
    expect(select).toBeGreaterThanOrEqual(0);
    expect(select).toBeLessThan(button);
  });

  it("keeps two plugins' nodes apart when they use the same keys", async () => {
    backend();
    const a = await roots("a");
    const b = await roots("b");
    expect(a.roots[0]?.key).not.toBe(b.roots[0]?.key);
  });

  it("asks the plugin's service provider for the selected node's pane", async () => {
    const { b } = backend();
    const serviceDetail = vi.fn(async () => [
      { id: "info", label: "Info", body: { kind: "text" as const, value: "Name: nginx" } },
    ]);
    setPluginsBackend({ ...b, serviceDetail });
    const provider = pluginServiceProvider("p", decl, "plugin", noMenu);
    const Detail = provider.detail!;
    const node: ServiceTreeItem = { key: "plugin:p/kube/pod:default/nginx", label: "nginx", icon: "folder" };
    render(<Detail item={node} />);
    await waitFor(() => expect(serviceDetail).toHaveBeenCalledWith("p", "kube", "pod:default/nginx"));
  });

  it("offers the view's item menu on its nodes", async () => {
    backend();
    const itemMenu = vi.fn((key: string) => [{ label: key, run: () => {} }]);
    const provider = pluginServiceProvider("p", decl, "plugin", itemMenu);
    const node: ServiceTreeItem = { key: "plugin:p/kube/pod:default/nginx", label: "nginx", icon: "folder" };
    expect(provider.menu?.(node)).toEqual([{ label: "pod:default/nginx", run: expect.any(Function) }]);
  });

  it("registers services views as providers and drops them with the plugin", () => {
    backend();
    const plugin = { id: "p", name: "P", status: "active", enabled: true } as unknown as Parameters<
      typeof syncUiContributions
    >[1][number];
    syncUiContributions([{ pluginId: "p", point: "views", key: "kube", decl }], [plugin]);
    expect(serviceProviders().map((p) => p.id)).toContain("plugin.p.kube");
    syncUiContributions([], [plugin]);
    expect(serviceProviders().map((p) => p.id)).not.toContain("plugin.p.kube");
  });
});

const remote = (config: string) => ({
  target: { kind: "ssh" as const, config },
  root: "/same",
  host: config,
  os: "linux",
  commands: [],
});

it("reloads Services roots when remote hosts share a project path", async () => {
  const { b } = backend();
  act(() => {
    useProject.setState({ project: { root: "/same" } as ProjectInfo });
    useRemote.setState({ session: remote("one") });
  });
  const provider = pluginServiceProvider("p", decl, "plugin", noMenu);
  renderHook(() => provider.useRoots());
  await waitFor(() => expect(b.renderView).toHaveBeenCalledTimes(1));
  act(() => useRemote.setState({ session: remote("two") }));
  await waitFor(() => expect(b.renderView).toHaveBeenCalledTimes(2));
});

it("drops queued Services selections after a remote host switch", async () => {
  const { b } = backend();
  let finish = () => {};
  const viewEvent = vi.fn<PluginsBackend["viewEvent"]>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  setPluginsBackend({ ...b, viewEvent });
  act(() => {
    useProject.setState({ project: { root: "/same" } as ProjectInfo });
    useRemote.setState({ session: remote("one") });
  });
  const provider = pluginServiceProvider("p", decl, "plugin", noMenu);
  provider.select?.({ key: "plugin:p/kube/a", label: "a", icon: "folder" });
  await waitFor(() => expect(viewEvent).toHaveBeenCalledOnce());
  provider.select?.({ key: "plugin:p/kube/b", label: "b", icon: "folder" });
  act(() => useRemote.setState({ session: remote("two") }));
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(viewEvent).toHaveBeenCalledOnce();
});

it("waits for the Services selection handler before requesting its detail", async () => {
  const { b } = backend();
  let finish = () => {};
  const viewEvent = vi.fn<PluginsBackend["viewEvent"]>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const serviceDetail = vi.fn(async () => []);
  setPluginsBackend({ ...b, viewEvent, serviceDetail });
  const provider = pluginServiceProvider("p", decl, "plugin", noMenu);
  const node = { key: "plugin:p/kube/a", label: "a", icon: "folder" };
  provider.select?.(node);
  const Detail = provider.detail!;
  render(<Detail item={node} />);
  await waitFor(() => expect(viewEvent).toHaveBeenCalledOnce());
  expect(serviceDetail).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(serviceDetail).toHaveBeenCalledWith("p", "kube", "a"));
});
