import { executeAction, getAction, isActionEnabled } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import type { ServiceItemAction, ServiceProviderContribution } from "@/workbench/contributions";
import type { Located } from "./tree";

/** A selected group already targets its descendants; don't invoke those twice. */
export function selectedServices(keys: Set<string>, index: Map<string, Located>): Located[] {
  const descendants = new Set<string>();
  const visit = (key: string) => {
    for (const child of index.get(key)?.item.children ?? []) {
      descendants.add(child.key);
      visit(child.key);
    }
  };
  keys.forEach(visit);
  return [...keys].flatMap((key) => {
    const node = index.get(key);
    return node && !descendants.has(key) ? [node] : [];
  });
}

function batch<T extends { disabled?: boolean; run?: () => void }>(items: T[]): T {
  const enabled = items.filter((item) => !item.disabled);
  return { ...items[0]!, disabled: !enabled.length, run: () => enabled.forEach((item) => item.run?.()) };
}

export function selectionActions(
  selection: Located[],
  providers: readonly ServiceProviderContribution[],
): ServiceItemAction[] {
  const groups = selection.map(({ item, provider }) => providers.find((p) => p.id === provider)?.actions?.(item) ?? []);
  return (groups[0] ?? []).flatMap((action) => {
    const matches = groups.flatMap((group) => group.filter((a) => a.id === action.id));
    return matches.length === groups.length ? [batch(matches)] : [];
  });
}

function menuKey(item: MenuItem): string | undefined {
  if (item.kind === "separator" || item.kind === "header") return undefined;
  return item.kind === "action" ? item.action : (item.id ?? item.label);
}

function commonMenu(groups: MenuItem[][]): MenuItem[] {
  return (groups[0] ?? []).flatMap((item): MenuItem[] => {
    const key = menuKey(item);
    if (!key) return [item];
    const matches = groups.flatMap((group) => group.filter((entry) => menuKey(entry) === key));
    if (matches.length !== groups.length) return [];
    const entries = matches
      .map((entry) => {
        if (entry.kind !== "action") return entry;
        const action = getAction(entry.action);
        return {
          label: entry.label ?? action?.title ?? entry.action,
          icon: entry.icon ?? action?.icon,
          disabled: entry.disabled || !action || !isActionEnabled(action),
          run: () => void executeAction(entry.action, entry.arg),
        };
      })
      .filter((entry) => entry.kind !== "separator" && entry.kind !== "header");
    const combined = batch(entries);
    // An ellipsis entry opens a dialog for one service; don't open one per selected row.
    if (groups.length > 1 && combined.label?.endsWith("…")) combined.disabled = true;
    if (entries.some((entry) => entry.submenu)) {
      combined.submenu = commonMenu(entries.map((entry) => (entry.disabled ? [] : (entry.submenu ?? []))));
    }
    return [combined];
  });
}

export function selectionMenu(selection: Located[], providers: readonly ServiceProviderContribution[]): MenuItem[] {
  const groups = selection.map(({ item, provider }) => providers.find((p) => p.id === provider)?.menu?.(item) ?? []);
  return groups.length === 1 ? groups[0]! : commonMenu(groups);
}
