/**
 * A plugin view declared with `location = "services"`: its tree's items are
 * nodes of the Services tool window, its toolbar the Services toolbar for
 * them, and the selected node's pane renders `"<view>/<item key>"`.
 */
import { useEffect, useMemo, useState } from "react";
import type { View, ViewEvent } from "@/bindings";
import type { ServiceProviderContribution, ServiceTreeItem } from "@/workbench/contributions";
import { pluginsBackend } from "../backend";
import { PluginView, treeNodes, type TreeNode } from "./PluginView";
import { useViewRevision } from "./viewStore";

interface ServicesViewDecl {
  id: string;
  title: string;
}

export function pluginServiceProvider(
  pluginId: string,
  decl: ServicesViewDecl,
  icon: string,
): ServiceProviderContribution {
  const prefix = `plugin:${pluginId}/${decl.id}/`;
  const rawKey = (item: ServiceTreeItem) => item.key.slice(prefix.length);
  let toolbar: View["toolbar"] = [];
  // Events of one node stay in order (a toolbar button after the select it acts on).
  let queue = Promise.resolve();
  const send = (event: ViewEvent) => {
    queue = queue
      .then(() => pluginsBackend().viewEvent(pluginId, decl.id, event, null))
      .catch((e: unknown) => console.warn(`plugin ${pluginId}: view ${decl.id}`, e));
  };
  const toItem = (n: TreeNode): ServiceTreeItem => ({
    key: prefix + n.item.key,
    label: n.item.label,
    icon: n.item.icon ?? icon,
    detail: n.item.detail ?? undefined,
    expanded: n.item.expanded,
    expandable: n.item.expandable,
    children: n.children.length || n.item.expandable ? n.children.map(toItem) : undefined,
  });

  return {
    id: `plugin.${pluginId}.${decl.id}`,
    order: 900,
    useRoots() {
      const revision = useViewRevision(pluginId, decl.id);
      const [view, setView] = useState<View | null>(null);
      useEffect(() => {
        let alive = true;
        pluginsBackend()
          .renderView(pluginId, decl.id, null, null)
          .then(
            (v) => {
              if (!alive) return;
              toolbar = v.toolbar;
              setView(v);
            },
            (e: unknown) => console.warn(`plugin ${pluginId}: view ${decl.id}`, e),
          );
        return () => {
          alive = false;
        };
      }, [revision]);
      return useMemo(() => (view?.body.kind === "tree" ? treeNodes(view.body.value).map(toItem) : []), [view]);
    },
    actions: (item) =>
      toolbar.map((b) => ({
        id: b.id,
        title: b.label,
        icon: b.icon ?? "plugin",
        disabled: !b.enabled,
        run: () => {
          send({ kind: "select", key: rawKey(item) });
          send({ kind: "button", id: b.id });
        },
      })),
    activate: (item) => send({ kind: "activate", key: rawKey(item) }),
    expand: (item, expanded) => send({ kind: expanded ? "expand" : "collapse", key: rawKey(item) }),
    detail: Detail,
  };

  function Detail({ item }: { item: ServiceTreeItem }) {
    // `views.refresh(<view>)` renders the open pane again too.
    const revision = useViewRevision(pluginId, decl.id);
    return (
      <PluginView pluginId={pluginId} view={`${decl.id}/${rawKey(item)}`} label={item.label} revision={revision} />
    );
  }
}
