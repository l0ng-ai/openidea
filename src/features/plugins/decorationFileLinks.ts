import type { PluginEditor } from "@/bindings";
import type { DocLinkHandler } from "@/editor/lsp/markdown";
import { tx } from "@/platform/i18n";
import { isCancelled } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { executeAction, type Action } from "@/platform/actions";
import { useRemote } from "@/platform/remote";
import { logError } from "@/platform/errorLog";
import { useProject } from "@/platform/project";
import { usePlugins } from "./store";
import { pluginsBackend } from "./backend";

const COMMAND = "open-decoration-file";
const ACTION = "plugins.openDecorationFile";
const requests = new WeakMap<object, () => Promise<void>>();

export const openDecorationFileAction: Action = {
  id: ACTION,
  title: "Open plugin file",
  category: "Plugins",
  hidden: true,
  enabled: ({ arg }) => typeof arg === "object" && arg !== null && requests.has(arg),
  run: async ({ arg }) => {
    if (typeof arg === "object" && arg !== null) await requests.get(arg)?.();
  },
};

/** A fragment carries an opaque metadata key, never a path or a command name. */
export function prepareDecorationFileLinks(
  plugin: string,
  editor: PluginEditor,
  isCurrent: () => boolean,
  isReady: () => boolean,
) {
  const backend = pluginsBackend();
  const controller = new AbortController();
  const project = useProject.getState().project;
  const root = project?.root;
  const remote = useRemote.getState().session;
  const remoteIdentity = JSON.stringify(remote);
  const current = () =>
    !controller.signal.aborted &&
    isCurrent() &&
    !!project?.trusted &&
    useProject.getState().project === project &&
    project.root === root &&
    !useProject.getState().opening &&
    useRemote.getState().session === remote &&
    JSON.stringify(remote) === remoteIdentity &&
    pluginsBackend() === backend &&
    (!remote || (remote.root === root && remote.commands.includes("plugin_run_command")));
  const eligible = () =>
    usePlugins
      .getState()
      .plugins.some(
        (info) =>
          info.id === plugin &&
          info.enabled &&
          info.hasCode &&
          (info.status === "active" || info.status === "inactive") &&
          info.activation.includes(`on-command:${COMMAND}`) &&
          info.capabilities.some((capability) => capability.id === "project.read" && capability.granted),
      );
  const dispose = () => {
    controller.abort();
    off.forEach((unsubscribe) => unsubscribe());
  };
  const invalidate = () => {
    if (!current() || !eligible()) dispose();
  };
  const off = [usePlugins.subscribe(invalidate), useProject.subscribe(invalidate), useRemote.subscribe(invalidate)];
  const onLink: DocLinkHandler = (href, event) => {
    if (/^https?:\/\//.test(href)) return false;
    const match = /^#openidea-file\/([A-Za-z0-9_-]{1,128})$/.exec(href);
    if (!match || !(event.target instanceof Element) || event.target.closest("blockquote, pre, code")) return true;
    if (!current() || !eligible() || !isReady()) return true;
    const request = {};
    requests.set(request, async () => {
      try {
        if (!current() || !eligible() || !isReady()) return;
        await backend.runCommand(
          plugin,
          COMMAND,
          JSON.stringify({ target: match[1] }),
          editor,
          [],
          undefined,
          undefined,
          controller.signal,
        );
      } catch (error) {
        if (current() && !isCancelled(error)) {
          logError("cannot open plugin decoration file", error);
          notifications().notify({
            group: "plugins",
            level: "error",
            title: tx("Cannot open plugin file"),
            body: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        requests.delete(request);
      }
    });
    void executeAction(ACTION, request);
    return true;
  };
  return { onLink, dispose };
}
