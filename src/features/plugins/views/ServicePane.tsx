/**
 * The detail-provider tabs of a selected item, shared by Services and tool windows.
 */
import { useEffect, useState } from "react";
import type { ServiceTab } from "@/bindings";
import { tx, VerbatimTextContext } from "@/platform/i18n";
import { EmptyState, LogPane, Spinner, Tabs } from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { pluginsBackend } from "../backend";
import { useToolWindowShown } from "@/workbench/contributions";
import { useViewLocation, useViewRevision } from "./viewStore";
import styles from "./ServicePane.module.css";

interface ServicePaneProps {
  pluginId: string;
  view: string;
  itemKey: string;
  after?: Promise<unknown>;
}

/** Plugin text is shown as written: the plugin translates it through its own catalog. */
export function ServicePane(props: ServicePaneProps) {
  const location = useViewLocation();
  const shown = useToolWindowShown();
  if (!shown) return null;
  return (
    <VerbatimTextContext.Provider value={true}>
      <ServicePaneContent key={JSON.stringify([props.pluginId, props.view, props.itemKey, location])} {...props} />
    </VerbatimTextContext.Provider>
  );
}

function ServicePaneContent({ pluginId, view, itemKey, after }: ServicePaneProps) {
  // `views.refresh(<view>)` asks for the pane again.
  const revision = useViewRevision(pluginId, view);
  const [tabs, setTabs] = useState<ServiceTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve(after)
      .then(() => (alive ? pluginsBackend().serviceDetail(pluginId, view, itemKey) : []))
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
  }, [pluginId, view, itemKey, revision, after]);

  if (error) return <EmptyState title={error} />;
  if (!tabs) return <Spinner />;
  const active = tabs.find((t) => t.id === picked) ?? tabs[0];
  if (!active) return <EmptyState title={tx("Nothing to show")} />;
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
