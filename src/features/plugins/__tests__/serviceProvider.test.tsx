import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, waitFor } from "@testing-library/react";
import type { View, ViewEvent, ViewTreeItem } from "@/bindings";
import { serviceProviders, type ServiceTreeItem } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, syncUiContributions } from "../projection";
import { pluginServiceProvider } from "../views/serviceProvider";

let undefinePoints: () => void = () => {};

beforeEach(() => {
  undefinePoints = defineBuiltinUiPoints();
});

afterEach(() => {
  clearUiContributions();
  undefinePoints();
  setPluginsBackend(null);
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

async function roots(pluginId: string) {
  const provider = pluginServiceProvider(pluginId, decl, "plugin");
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

  it("routes events with the raw key", async () => {
    const { events } = backend();
    const { provider, roots: nodes } = await roots("p");
    const nginx = nodes[0]!.children![0]!.children![0]!;
    provider.activate?.(nginx);
    await waitFor(() => expect(events).toContainEqual(["p", "kube", { kind: "activate", key: "pod:default/nginx" }]));
    provider.actions?.(nginx)[0]?.run();
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

  it("renders the selected node's detail as <view>/<key>", async () => {
    const { b } = backend({ toolbar: [], status: null, body: { kind: "text", value: "Name: nginx" } });
    const provider = pluginServiceProvider("p", decl, "plugin");
    const Detail = provider.detail!;
    const node: ServiceTreeItem = { key: "plugin:p/kube/pod:default/nginx", label: "nginx", icon: "folder" };
    render(<Detail item={node} />);
    await waitFor(() => expect(b.renderView).toHaveBeenCalledWith("p", "kube/pod:default/nginx", null, null));
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
