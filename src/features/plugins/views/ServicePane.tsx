/**
 * The Services pane of a node of a plugin's `location = "services"` view: the
 * tabs its `service-provider` returns, switched here without calling the plugin.
 */
import { useEffect, useState } from "react";
import type { ServiceTab } from "@/bindings";
import { EmptyState, LogPane, Spinner, Tabs } from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { pluginsBackend } from "../backend";
import { useViewRevision } from "./viewStore";
import styles from "./ServicePane.module.css";

interface ServicePaneProps {
  pluginId: string;
  view: string;
  itemKey: string;
}

export function ServicePane({ pluginId, view, itemKey }: ServicePaneProps) {
  // `views.refresh(<view>)` asks for the pane again.
  const revision = useViewRevision(pluginId, view);
  const [tabs, setTabs] = useState<ServiceTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    pluginsBackend()
      .serviceDetail(pluginId, view, itemKey)
      .then(
        (t) => {
          if (!alive) return;
          setTabs(t);
          setError(null);
        },
        (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [pluginId, view, itemKey, revision]);

  if (error) return <EmptyState title={error} />;
  if (!tabs) return <Spinner />;
  const active = tabs.find((t) => t.id === picked) ?? tabs[0];
  if (!active) return <EmptyState title="Nothing to show" />;
  return (
    <div className={styles.pane}>
      <Tabs
        variant="compact"
        activeId={active.id}
        onSelect={setPicked}
        items={tabs.map((t) => ({ id: t.id, label: t.label }))}
      />
      <div className={styles.body}>
        <TabBody key={active.id} tab={active} pluginId={pluginId} view={view} itemKey={itemKey} />
      </div>
    </div>
  );
}

function TabBody({ tab, pluginId, view, itemKey }: ServicePaneProps & { tab: ServiceTab }) {
  const body = tab.body;
  switch (body.kind) {
    case "message":
      return <EmptyState title={body.value} />;
    case "text":
      return (
        <pre role="document" tabIndex={0} className={styles.text} onKeyDown={copySelectionOnKeyDown}>
          {body.value}
        </pre>
      );
    case "log":
      return (
        <LogPane
          // A refresh that changes what runs starts it again.
          sourceKey={JSON.stringify([pluginId, view, itemKey, tab.id, body.value])}
          live
          toggles={body.value.toggles}
          ariaLabel={tab.label}
          start={(onLine, onError, on, onExit) =>
            pluginsBackend().serviceLog(pluginId, view, itemKey, tab.id, on, onLine, onError, onExit)
          }
        />
      );
  }
}
