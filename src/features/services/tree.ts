/**
 * The Services tree host: the root nodes service providers contribute, the
 * selection and expansion, and which provider owns a node.
 */
import { create } from "zustand";
import type { MenuItem } from "@/ui";
import { serviceProviders, type ServiceProviderContribution, type ServiceTreeItem } from "@/workbench/contributions";

/** The service view (Services tool window tab) hosting the tree. */
export const SERVICES_TREE_VIEW = "services";

interface TreeState {
  /** Root nodes per provider id (reported by each provider's `useRoots`). */
  roots: Record<string, ServiceTreeItem[]>;
  selectedKey: string | null;
  expanded: Set<string>;
}

export const useServicesTree = create<TreeState>(() => ({
  roots: {},
  selectedKey: null,
  expanded: new Set(["docker:default", "docker:default:group:containers"]),
}));

/** Keys of nodes asking to start expanded that were shown once (collapsing them then sticks). */
const seenExpanded = new Set<string>();

export function setProviderRoots(provider: string, items: ServiceTreeItem[]) {
  useServicesTree.setState((s) => {
    if (s.roots[provider] === items) return s;
    const fresh: string[] = [];
    const visit = (i: ServiceTreeItem) => {
      if (i.expanded && !seenExpanded.has(i.key)) {
        seenExpanded.add(i.key);
        fresh.push(i.key);
      }
      i.children?.forEach(visit);
    };
    items.forEach(visit);
    const roots = { ...s.roots, [provider]: items };
    return fresh.length ? { roots, expanded: new Set([...s.expanded, ...fresh]) } : { roots };
  });
}

export function clearProviderRoots(provider: string) {
  useServicesTree.setState((s) => {
    if (!(provider in s.roots)) return s;
    const roots = { ...s.roots };
    delete roots[provider];
    return { roots };
  });
}

export interface Located {
  item: ServiceTreeItem;
  provider: string;
}

/** Every node by key, with the provider owning it. */
export function indexTree(roots: Record<string, readonly ServiceTreeItem[]>): Map<string, Located> {
  const out = new Map<string, Located>();
  const visit = (provider: string, item: ServiceTreeItem) => {
    out.set(item.key, { item, provider });
    item.children?.forEach((c) => visit(provider, c));
  };
  for (const [provider, items] of Object.entries(roots)) items.forEach((i) => visit(provider, i));
  return out;
}

/** Roots of all providers, in provider order. */
export function orderedRoots(
  roots: Record<string, readonly ServiceTreeItem[]>,
  providers: readonly ServiceProviderContribution[],
): ServiceTreeItem[] {
  return providers.flatMap((p) => roots[p.id] ?? []);
}

/** Keys of every expandable node (Expand All). */
export function expandableKeys(items: readonly ServiceTreeItem[]): string[] {
  const out: string[] = [];
  const visit = (i: ServiceTreeItem) => {
    if (i.children?.length) {
      out.push(i.key);
      i.children.forEach(visit);
    }
  };
  items.forEach(visit);
  return out;
}

/** The "Add Service" menu: every provider's entries, separated per provider. */
export function addServiceMenu(providers = serviceProviders()): MenuItem[] {
  const groups = providers.map((p) => p.addMenu?.() ?? []).filter((g) => g.length > 0);
  return groups.flatMap((g, i) => (i === 0 ? g : [{ kind: "separator" } as MenuItem, ...g]));
}
