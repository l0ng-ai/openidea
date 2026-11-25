/** The content of the Flutter DevTools tool windows: a page of the project's DevTools server. */
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { IconButton, Tabs, type TabItem } from "@/ui";
import { useFlutterDevices } from "@/workbench/flutterDevices";
import { useFlutterRunApps } from "@/workbench/flutterRunApps";
import {
  currentDevToolsLook,
  DEVTOOLS_WINDOWS,
  devToolsUrl,
  useDevToolsRefresh,
  WIDGET_PREVIEW_WINDOW,
  widgetPreviewUrl,
  type DevToolsWindow,
} from "../flutter/devTools";
import { isLive, useDebug } from "../state";
import styles from "./FlutterDevTools.module.css";

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";

/** The Inspector tab chosen by hand; a new or remaining app is shown otherwise. */
const useInspectorTab = create<{ app: string | null }>(() => ({ app: null }));

/** A Flutter app with a VM Service: of a Debug session, or of a Run tab (`flutter run --machine`). */
interface FlutterApp {
  key: string;
  name: string;
  device?: string | null;
  uri: string;
  live: boolean;
  startedAt: number;
}

/** Every app with a VM Service, ended ones too, oldest first. */
function useFlutterApps(): FlutterApp[] {
  const sessions = useDebug((s) => s.sessions);
  const runApps = useFlutterRunApps();
  return useMemo(() => {
    const debug = Object.values(sessions).flatMap((s) =>
      s.vmServiceUri
        ? [
            {
              key: `debug:${s.id}`,
              name: s.name,
              device: s.flutterDevice,
              uri: s.vmServiceUri,
              live: isLive(s),
              startedAt: s.startedAt ?? 0,
            },
          ]
        : [],
    );
    const run = Object.values(runApps).flatMap((a) =>
      a.vmServiceUri
        ? [
            {
              key: `run:${a.session}`,
              name: a.name,
              device: a.device,
              uri: a.vmServiceUri,
              live: a.live,
              startedAt: a.startedAt,
            },
          ]
        : [],
    );
    return [...debug, ...run].sort((a, b) => a.startedAt - b.startedAt);
  }, [sessions, runApps]);
}

function useRunningApps(): FlutterApp[] {
  const apps = useFlutterApps();
  return useMemo(() => apps.filter((a) => a.live), [apps]);
}

function shownApp(apps: FlutterApp[], chosen: string | null) {
  return apps.find((a) => a.key === chosen) ?? apps.at(-1);
}

type Server = { url: string } | { error: string };

/** The server's address; asks again on Refresh and when the project's trust changes. */
function useServer(start: typeof commands.flutterDevtoolsUrl, refresh: number): Server | null {
  const trusted = useProject((s) => s.project?.trusted);
  const request = `${refresh}/${trusted}`;
  const [answer, setAnswer] = useState<{ request: string; server: Server } | null>(null);
  useEffect(() => {
    let live = true;
    call(start()).then(
      (url) => live && setAnswer({ request, server: { url } }),
      (e: unknown) => live && setAnswer({ request, server: { error: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      live = false;
    };
  }, [start, request]);
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
  const chosen = useInspectorTab((s) => s.app);
  const shown = shownApp(apps, chosen);
  if (!shown) return <div className={styles.message}>{tx("No running applications")}</div>;
  // One page per app, kept while another is shown: each holds its own selection.
  return apps.map((app) => (
    <Frame key={app.key} server={server} window={window} uri={app.uri} hidden={app !== shown} />
  ));
}

function LatestApp({ server, window }: { server: string; window: DevToolsWindow }) {
  // Ended apps count: the page stays on the last app until another one starts.
  const uri = useFlutterApps().at(-1)?.uri;
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
  const server = useServer(commands.flutterDevtoolsUrl, refresh);
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
  const chosen = useInspectorTab((s) => s.app);
  const devices = useFlutterDevices((s) => s.list?.devices);
  if (!apps.length) return null;
  const items: TabItem[] = apps.map((app) => {
    const device = devices?.find((d) => d.id === app.device)?.name ?? app.device ?? app.name;
    return { id: app.key, label: device, text: device };
  });
  return (
    <Tabs
      variant="compact"
      aria-label={tx("Running applications")}
      items={items}
      activeId={shownApp(apps, chosen)?.key ?? null}
      onSelect={(app) => useInspectorTab.setState({ app })}
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

/** The `@Preview` widgets of the project, from its `flutter widget-preview` server. */
export function FlutterWidgetPreviewView() {
  const tx = useTx();
  // Like DevTools, the server would start on the remote machine, out of reach.
  const content = isRemoteWindow() ? (
    <div className={styles.message}>{tx("Flutter Widget Preview isn't available in a remote project yet")}</div>
  ) : (
    <WidgetPreview />
  );
  return <div className={styles.pane}>{content}</div>;
}

function WidgetPreview() {
  const tx = useTx();
  const refresh = useDevToolsRefresh((s) => s[WIDGET_PREVIEW_WINDOW] ?? 0);
  const server = useServer(commands.flutterWidgetPreviewUrl, refresh);
  const [look] = useState(() => currentDevToolsLook());
  // The first start compiles the preview environment, which can take a minute.
  if (!server) return <div className={styles.message}>{tx("Starting Flutter Widget Preview…")}</div>;
  if ("error" in server)
    return (
      <div className={styles.message}>
        {tx("Flutter Widget Preview start-up failed")}: {server.error}
      </div>
    );
  return (
    <iframe
      key={refresh}
      className={styles.frame}
      title={tx("Flutter Widget Preview")}
      src={widgetPreviewUrl(server.url, look)}
      sandbox={SANDBOX}
    />
  );
}

export function FlutterWidgetPreviewRefresh() {
  return (
    <IconButton
      icon="refresh"
      size="small"
      iconSize={16}
      action="debug.refreshWidgetPreview"
      title="Refresh Flutter Widget Preview"
    />
  );
}
