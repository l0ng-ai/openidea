import { useEffect, useState, type FunctionComponent } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { evaluateWhen, useContextKeys } from "@/platform/context";
import { VerbatimTextContext } from "@/platform/i18n";
import { Tabs } from "@/ui";
import {
  registerToolWindow,
  toolWindowService,
  ToolWindowShownProvider,
  useToolWindowShown,
  type ToolWindowAnchor,
} from "@/workbench/contributions";
import { pluginToolWindowId, viewKey } from "./viewStore";
import styles from "./PluginView.module.css";

export interface WindowView {
  id: string;
  title: string;
  location: ToolWindowAnchor;
  secondary?: boolean;
  header?: "default" | "none" | null;
  group?: string | null;
  when?: string | null;
}

interface Member {
  decl: WindowView;
  icon: string;
  order: number;
  component: FunctionComponent;
}

interface WindowState {
  members: Member[];
  selected: string | null;
}

interface WindowGroup {
  members: Map<string, Member>;
  state: UseBoundStore<StoreApi<WindowState>>;
  dispose: () => void;
  unsubscribe: () => void;
  signature: string;
  component: FunctionComponent;
}

const groups = new Map<string, WindowGroup>();
const windowsByView = new Map<string, { window: string; group: WindowGroup }>();

function GroupView({ group, id }: { group: WindowGroup; id: string }) {
  const { members, selected } = group.state();
  const active = members.find((m) => m.decl.id === selected) ?? members[0];
  const activeId = active?.decl.id;
  const shown = useToolWindowShown();
  // Like separate tool windows, opened tabs retain their local state until withdrawn.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setVisited((previous) => {
      const next = new Set(
        members.filter((m) => previous.has(m.decl.id) || m.decl.id === activeId).map((m) => m.decl.id),
      );
      return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
    });
  }, [members, activeId]);
  if (!active) return null;
  return (
    <VerbatimTextContext.Provider value={true}>
      <div className={styles.view}>
        <Tabs
          variant="compact"
          panelIdPrefix={id}
          items={members.map(({ decl }) => ({ id: decl.id, label: decl.title }))}
          activeId={active.decl.id}
          onSelect={(id) => group.state.setState({ selected: id })}
        />
        {members
          .filter((m) => visited.has(m.decl.id) || m.decl.id === activeId)
          .map((member) => {
            const Body = member.component;
            const selected = member.decl.id === activeId;
            return (
              <div
                key={member.decl.id}
                className={styles.body}
                role="tabpanel"
                id={`${id}-panel-${member.decl.id}`}
                aria-labelledby={`${id}-tab-${member.decl.id}`}
                hidden={!selected}
              >
                <ToolWindowShownProvider value={shown && selected}>
                  <Body />
                </ToolWindowShownProvider>
              </div>
            );
          })}
      </div>
    </VerbatimTextContext.Provider>
  );
}

function refresh(id: string, group: WindowGroup) {
  const ordered = [...group.members.values()].sort((a, b) => a.order - b.order);
  const first = ordered[0];
  const members = ordered.filter((m) => evaluateWhen(m.decl.when ?? undefined));
  const selected = group.state.getState().selected;
  group.state.setState({
    members,
    selected: selected ?? members[0]?.decl.id ?? null,
  });
  const secondary = first?.decl.secondary === true;
  const signature =
    first && members.length ? JSON.stringify([first.decl.title, first.decl.location, secondary, first.icon]) : "";
  if (signature === group.signature) return;
  group.dispose();
  group.signature = signature;
  group.dispose =
    first && members.length
      ? registerToolWindow({
          id,
          title: first.decl.title,
          verbatim: true,
          anchor: first.decl.location,
          secondary,
          icon: first.icon,
          order: 900,
          component: first.decl.group ? group.component : first.component,
        })
      : () => {};
}

/** Group names are scoped to their plugin and cannot collide with an ungrouped view id. */
export function registerWindowView(
  pluginId: string,
  decl: WindowView,
  icon: string,
  component: FunctionComponent,
  order = 0,
) {
  const id = decl.group ? `plugin.${pluginId}.group:${decl.group}` : pluginToolWindowId(pluginId, decl.id);
  let group = groups.get(id);
  if (!group) {
    group = {
      members: new Map(),
      state: create<WindowState>(() => ({ members: [], selected: null })),
      dispose: () => {},
      unsubscribe: () => {},
      signature: "",
      component: () => null,
    };
    const current = group;
    group.component = () => <GroupView group={current} id={id} />;
    group.unsubscribe = useContextKeys.subscribe(() => refresh(id, current));
    groups.set(id, group);
  }
  const current = group;
  const member = { decl, icon, component, order };
  current.members.set(decl.id, member);
  windowsByView.set(viewKey(pluginId, decl.id), { window: id, group: current });
  refresh(id, current);
  return {
    setIcon(next: string) {
      member.icon = next;
      refresh(id, current);
    },
    dispose() {
      current.members.delete(decl.id);
      windowsByView.delete(viewKey(pluginId, decl.id));
      if (current.members.size) refresh(id, current);
      else {
        current.dispose();
        current.unsubscribe();
        groups.delete(id);
      }
    },
  };
}

/** A hidden view stays hidden; revealing a grouped view selects its own tab. */
export function revealWindowView(pluginId: string, view: string) {
  const entry = windowsByView.get(viewKey(pluginId, view));
  if (!entry?.group.state.getState().members.some((m) => m.decl.id === view)) return;
  entry.group.state.setState({ selected: view });
  toolWindowService().show(entry.window, true);
}
