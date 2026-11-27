import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectInfo, RemoteSession, View } from "../src/bindings";
import { createMemoryPluginsBackend, setPluginsBackend } from "../src/features/plugins/backend";
import { PluginView } from "../src/features/plugins/views/PluginView";
import { bumpView } from "../src/features/plugins/views/viewStore";
import { useProject } from "../src/platform/project";
import { useRemote } from "../src/platform/remote";
import "../src/styles/tokens.css";

const remote = (config: string): RemoteSession => ({
  target: { kind: "ssh", config },
  root: "/same",
  host: config,
  os: "linux",
  commands: [],
});
useProject.setState({ project: { root: "/same" } as ProjectInfo });
useRemote.setState({ session: remote("one") });

let removed = false;
let revision = 0;
let selected = "";
setPluginsBackend({
  ...createMemoryPluginsBackend([]),
  renderView: async (_p, view): Promise<View> => ({
    toolbar: [
      { id: "remove", label: "Remove alpha", icon: null, enabled: true },
      { id: "refresh", label: "Refresh details", icon: null, enabled: true },
    ],
    status: null,
    body: {
      kind: view === "tree" ? "tree" : "list",
      value: (removed ? ["beta"] : ["alpha", "beta"]).map((key) => ({
        key,
        label: key,
        icon: null,
        detail: null,
        parent: null,
        expanded: false,
        expandable: false,
      })),
    },
  }),
  viewEvent: async (_p, view, event) => {
    if (event.kind === "select") selected = event.key;
    if (event.kind === "button") {
      if (event.id === "remove") removed = true;
      revision++;
      bumpView("fixture", view);
    }
  },
  serviceDetail: async (_p, view, key) => {
    if (selected !== key) throw new Error("select was not handled");
    return [
      { id: "info", label: "Info", body: { kind: "text", value: `${view}: ${key}\nRevision ${revision}` } },
      { id: "summary", label: "Summary", body: { kind: "message", value: `Selected ${key}` } },
    ];
  },
});
function Fixture() {
  const kind = new URLSearchParams(location.search).get("kind") === "tree" ? "tree" : "list";
  const [shown, setShown] = useState(true);
  const [host, setHost] = useState("one");
  return (
    <>
      <button onClick={() => setShown((value) => !value)}>Toggle view</button>
      <button
        onClick={() => {
          const next = host === "one" ? "two" : "one";
          useRemote.setState({ session: remote(next) });
          setHost(next);
        }}
      >
        Switch remote host
      </button>
      <output aria-label="Remote host">{host}</output>
      <div style={{ height: 400, width: 900 }}>{shown && <PluginView pluginId="fixture" view={kind} detail />}</div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
