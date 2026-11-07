/**
 * A plugin view declared with `location = "services"`: its tree's items are
 * nodes of the Services tool window, its toolbar the Services toolbar for one
 * selected node, `viewItem.context` its nodes' right-click menu, and the
 * plugin's `service-provider` the selected node's pane.
 */
import { useEffect, useMemo, useState } from "react";
import type { View, ViewEvent } from "@/bindings";
import type { MenuItem } from "@/ui";
import type { ServiceProviderContribution, ServiceTreeItem } from "@/workbench/contributions";
import { pluginsBackend } from "../backend";
import { treeNodes, type TreeNode } from "./PluginView";
import { ServicePane } from "./ServicePane";
import { useViewRevision } from "./viewStore";

interface ServicesViewDecl {
  id: string;
  title: string;
}

export function pluginServiceProvider(
  pluginId: string,
  decl: ServicesViewDecl,
  icon: string,
  itemMenu: (key: string) => MenuItem[],
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
    // Ids per node: the Services toolbar offers an action of several selected
    // nodes only when they share its id, and a plugin's buttons act on one.
    actions: (item) =>
      toolbar.map((b) => ({
        id: `${item.key}\0${b.id}`,
        title: b.label,
        icon: b.icon ?? "plugin",
        disabled: !b.enabled,
        run: () => {
          send({ kind: "select", key: rawKey(item) });
          send({ kind: "button", id: b.id });
        },
      })),
    menu: (item) => itemMenu(rawKey(item)),
    select: (item) => send({ kind: "select", key: rawKey(item) }),
    activate: (item) => send({ kind: "activate", key: rawKey(item) }),
    expand: (item, expanded) => send({ kind: expanded ? "expand" : "collapse", key: rawKey(item) }),
    detail: Detail,
  };

  function Detail({ item }: { item: ServiceTreeItem }) {
    return <ServicePane pluginId={pluginId} view={decl.id} itemKey={rawKey(item)} />;
  }
}
