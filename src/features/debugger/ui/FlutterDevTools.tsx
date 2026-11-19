/** The content of the Flutter DevTools tool windows: a page of the project's DevTools server. */
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useTx } from "@/platform/i18n";
import { call, commands, type DebugSessionId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { IconButton, Tabs, type TabItem } from "@/ui";
import { useFlutterDevices } from "@/workbench/flutterDevices";
import {
  currentDevToolsLook,
  DEVTOOLS_WINDOWS,
  devToolsUrl,
  useDevToolsRefresh,
  type DevToolsWindow,
} from "../flutter/devTools";
import { isLive, useDebug, type DebugSession } from "../state";
import styles from "./FlutterDevTools.module.css";

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";

/** The Inspector tab chosen by hand; a new or remaining app is shown otherwise. */
const useInspectorTab = create<{ session: DebugSessionId | null }>(() => ({ session: null }));

const hasApp = (s: DebugSession) => !!s.vmServiceUri;

function useRunningApps(): DebugSession[] {
  const sessions = useDebug((s) => s.sessions);
  return useMemo(() => Object.values(sessions).filter((s) => hasApp(s) && isLive(s)), [sessions]);
}

function shownApp(apps: DebugSession[], chosen: DebugSessionId | null) {
  return apps.find((s) => s.id === chosen) ?? apps.at(-1);
}

type Server = { url: string } | { error: string };

/** The server's address; asks again on Refresh and when the project's trust changes. */
function useDevToolsServer(refresh: number): Server | null {
  const trusted = useProject((s) => s.project?.trusted);
  const request = `${refresh}/${trusted}`;
  const [answer, setAnswer] = useState<{ request: string; server: Server } | null>(null);
  useEffect(() => {
    let live = true;
    call(commands.flutterDevtoolsUrl()).then(
      (url) => live && setAnswer({ request, server: { url } }),
      (e: unknown) => live && setAnswer({ request, server: { error: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      live = false;
    };
  }, [request]);
  return answer?.request === request ? answer.server : null;
}

function Frame({
  server,
  window,
  uri,
  hidden,
}: {
  server: string;
  window: DevToolsWindow;
  uri?: string;
  hidden?: boolean;
}) {
  const tx = useTx();
  const [look] = useState(() => currentDevToolsLook());
  return (
    <iframe
      className={styles.frame}
      title={tx(window.title)}
      src={devToolsUrl(server, window, { uri, embedded: look })}
      sandbox={SANDBOX}
      hidden={hidden}
    />
  );
}

function Inspector({ server, window }: { server: string; window: DevToolsWindow }) {
  const tx = useTx();
  const apps = useRunningApps();
  const chosen = useInspectorTab((s) => s.session);
  const shown = shownApp(apps, chosen);
  if (!shown) return <div className={styles.message}>{tx("No running applications")}</div>;
  // One page per app, kept while another is shown: each holds its own selection.
  return apps.map((app) => (
    <Frame key={app.id} server={server} window={window} uri={app.vmServiceUri} hidden={app !== shown} />
  ));
}

function LatestApp({ server, window }: { server: string; window: DevToolsWindow }) {
  // Ended sessions count: the page stays on the last app until another one starts.
  const uri = useDebug((s) => Object.values(s.sessions).findLast(hasApp)?.vmServiceUri);
  return <Frame server={server} window={window} uri={uri} />;
}

export function FlutterDevToolsView({ id }: { id: string }) {
  const tx = useTx();
  // No request in a remote window: the server would start on the remote machine, out of reach.
  const content = isRemoteWindow() ? (
    <div className={styles.message}>{tx("Flutter DevTools isn't available in a remote project yet")}</div>
  ) : (
    <LocalView id={id} />
  );
  return <div className={styles.pane}>{content}</div>;
}

function LocalView({ id }: { id: string }) {
  const tx = useTx();
  const window = DEVTOOLS_WINDOWS.find((w) => w.id === id)!;
  const refresh = useDevToolsRefresh((s) => s[id] ?? 0);
  const server = useDevToolsServer(refresh);
  if (!server) return <div className={styles.message}>{tx("Loading Flutter DevTools…")}</div>;
  if ("error" in server)
    return (
      <div className={styles.message}>
        {tx("Flutter DevTools start-up failed")}: {server.error}
      </div>
    );
  if (window.app === "each") return <Inspector key={refresh} server={server.url} window={window} />;
  if (window.app === "latest") return <LatestApp key={refresh} server={server.url} window={window} />;
  return <Frame key={refresh} server={server.url} window={window} />;
}

/** One tab per running app, named after its device. */
export function FlutterDevToolsTabs() {
  const tx = useTx();
  const apps = useRunningApps();
  const chosen = useInspectorTab((s) => s.session);
  const devices = useFlutterDevices((s) => s.list?.devices);
  if (!apps.length) return null;
  const items: TabItem[] = apps.map((app) => {
    const device = devices?.find((d) => d.id === app.flutterDevice)?.name ?? app.flutterDevice ?? app.name;
    return { id: String(app.id), label: device, text: device };
  });
  return (
    <Tabs
      variant="compact"
      aria-label={tx("Running applications")}
      items={items}
      activeId={String(shownApp(apps, chosen)?.id)}
      onSelect={(id) => useInspectorTab.setState({ session: +id as DebugSessionId })}
    />
  );
}

export function FlutterDevToolsRefresh({ id }: { id: string }) {
  return (
    <IconButton
      icon="refresh"
      size="small"
      iconSize={16}
      action="debug.refreshDevTools"
      actionArg={id}
      title="Refresh Flutter DevTools"
    />
  );
}
