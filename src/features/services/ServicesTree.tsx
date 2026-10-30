/**
 * The Services tree (IDEA's Services view): the nodes every service provider
 * contributes (Docker connections, run configurations…) on the left, the
 * selected node's detail on the right, "Add Service" (+, ⌘N) on the toolbar.
 */
import { useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { setContext } from "@/platform/context";
import { useTxTemplate, tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import {
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tree,
  showContextMenu,
  T,
  type TreeRowState,
} from "@/ui";
import {
  useServiceProviders,
  serviceProviders,
  type ServiceProviderContribution,
  type ServiceTreeItem,
} from "@/workbench/contributions";
import {
  addServiceMenu,
  clearProviderRoots,
  expandableKeys,
  indexTree,
  orderedRoots,
  setProviderRoots,
  useServicesTree,
} from "./tree";
import styles from "./Services.module.css";
import { selectionActions, selectionMenu, selectedServices } from "./selection";

export const SERVICES_VIEW_FOCUS = "servicesViewFocus";

/** Reports one provider's roots into the tree store (hooks can't run in a loop over providers). */
function ProviderRoots({ provider }: { provider: ServiceProviderContribution }) {
  const roots = provider.useRoots();
  useEffect(() => setProviderRoots(provider.id, roots), [provider.id, roots]);
  useEffect(() => () => clearProviderRoots(provider.id), [provider.id]);
  useEffect(() => provider.watch?.(), [provider]);
  return null;
}

function useProviders(): ServiceProviderContribution[] {
  const map = useServiceProviders((s) => s.providers);
  return useMemo(() => serviceProviders(map), [map]);
}

/** Opens the "Add Service" menu below `anchor` (or at the selected row / top left). */
export function showAddServiceMenu(anchor?: Element | null) {
  const el = anchor ?? document.querySelector("[data-services-add]");
  const r = el?.getBoundingClientRect();
  showContextMenu({ x: r?.left ?? 100, y: (r?.bottom ?? 100) + 2 }, addServiceMenu());
}

function Row({ item, state }: { item: ServiceTreeItem; state: TreeRowState }) {
  const txTemplate = useTxTemplate();
  return (
    <span className={styles.row}>
      <Icon name={item.icon} size={16} className={styles.icon} />
      <span className={clsx(styles.label, state.selected && styles.selectedLabel, item.dim && styles.dim)}>
        {item.label}
      </span>
      {item.detail && <span className={styles.detail}>{txTemplate(item.detail)}</span>}
    </span>
  );
}

export function ServicesTreeView() {
  const providers = useProviders();
  const rootsByProvider = useServicesTree((s) => s.roots);
  const selectedKey = useServicesTree((s) => s.selectedKey);
  const selectedKeys = useServicesTree((s) => s.selectedKeys);
  const expanded = useServicesTree((s) => s.expanded);
  const addRef = useRef<HTMLButtonElement>(null);

  const roots = useMemo(() => orderedRoots(rootsByProvider, providers), [rootsByProvider, providers]);
  const index = useMemo(() => indexTree(rootsByProvider), [rootsByProvider]);
  const selected = selectedKey ? (index.get(selectedKey) ?? null) : null;
  const owner = selected ? providers.find((p) => p.id === selected.provider) : undefined;
  const actions = selectionActions(selectedServices(selectedKeys, index), providers);
  const Detail = owner?.detail;
  const add = shortcutLabel("services.addService");

  return (
    <div className={styles.view}>
      {providers.map((p) => (
        <ProviderRoots key={p.id} provider={p} />
      ))}
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Services actions")}>
        <IconButton
          ref={addRef}
          data-services-add
          icon="plus"
          size="small"
          iconSize={16}
          action="services.addService"
          onClick={() => showAddServiceMenu(addRef.current)}
        />
        <span className={styles.sep} />
        <IconButton
          icon="expand-all"
          size="small"
          iconSize={16}
          title="Expand All"
          disabled={!roots.length}
          onClick={() => useServicesTree.setState({ expanded: new Set(expandableKeys(roots)) })}
        />
        <IconButton
          icon="collapse-all"
          size="small"
          iconSize={16}
          title="Collapse All"
          disabled={!roots.length}
          onClick={() => useServicesTree.setState({ expanded: new Set() })}
        />
        {actions.length > 0 && <span className={styles.sep} />}
        {actions.map((a) => (
          <IconButton
            key={a.id}
            icon={a.icon}
            size="small"
            iconSize={16}
            title={a.title}
            disabled={a.disabled}
            onClick={a.run}
          />
        ))}
      </div>
      {providers.map((p) => p.banner && <p.banner key={p.id} />)}
      {!roots.length ? (
        <div className={styles.empty}>
          <T>No services configured.</T>
          <button type="button" className={styles.link} onClick={(e) => showAddServiceMenu(e.currentTarget)}>
            <Icon name="plus" size={14} />
            <T>Add service</T>
            {add && <span className={styles.shortcut}>{add}</span>}
          </button>
        </div>
      ) : (
        <SplitGroup orientation="horizontal" className={styles.split}>
          <SplitPanel defaultSize="40%" minSize="160px">
            <div
              className={styles.tree}
              onFocus={(e) =>
                setContext(SERVICES_VIEW_FOCUS, (e.target as HTMLElement).getAttribute("role") === "tree")
              }
              onBlur={() => setContext(SERVICES_VIEW_FOCUS, false)}
            >
              <Tree<ServiceTreeItem>
                roots={roots}
                getKey={(n) => n.key}
                getLabel={(n) => n.label}
                getChildren={(n) => n.children}
                isExpandable={(n) => !!n.children?.length}
                expanded={expanded}
                onExpandedChange={(next) => useServicesTree.setState({ expanded: next })}
                selected={selectedKeys}
                onSelectionChange={(keys, lead) =>
                  useServicesTree.setState({ selectedKeys: keys, selectedKey: keys.size ? (lead?.key ?? null) : null })
                }
                renderNode={(n, state) => <Row item={n} state={state} />}
                onActivate={(n) => {
                  const p = index.get(n.key);
                  providers.find((x) => x.id === p?.provider)?.activate?.(n);
                }}
                onContextMenu={(n, keys, e) => {
                  e.preventDefault();
                  if (!n) {
                    showContextMenu({ x: e.clientX, y: e.clientY }, addServiceMenu(providers));
                    return;
                  }
                  useServicesTree.setState({ selectedKeys: keys, selectedKey: n.key });
                  const items = selectionMenu(selectedServices(keys, index), providers);
                  if (items.length) showContextMenu({ x: e.clientX, y: e.clientY }, items);
                }}
                speedSearch
                aria-label="Services"
                className={styles.tree}
              />
            </div>
          </SplitPanel>
          <SplitHandle />
          <SplitPanel minSize="200px">
            {selected && Detail ? (
              <Detail key={selected.item.key} item={selected.item} />
            ) : (
              <EmptyState title="Select service to view details" />
            )}
          </SplitPanel>
        </SplitGroup>
      )}
    </div>
  );
}
