import { tx } from "@/platform/i18n";
import { ICON_NAMES, type IconName } from "@/ui";
import { pluginsBackend } from "../backend";
import { usePlugins } from "../store";
import { onViewMessage } from "./viewStore";

export const PLUGIN_CONTENT_EDITOR_KIND = "pluginContent";

const BUILTIN_ICONS = new Set<string>(ICON_NAMES);

export interface PluginContentActionSpec {
  id: string;
  label: string;
  icon?: IconName;
  primary?: boolean;
  save?: boolean;
}

export interface PluginContentEditorData {
  pluginId: string;
  view: string;
  key: string;
  title: string;
  language?: string;
  fileName?: string;
  content: string;
  readOnly: boolean;
  actions: PluginContentActionSpec[];
}

export interface ContentTabDiff {
  left: string;
  right: string;
  leftLabel?: string;
  rightLabel?: string;
  title?: string;
}

export interface ContentTabReply {
  op: "content-tab-reply";
  requestId: string;
  content?: string;
  saved?: boolean;
  readOnly?: boolean;
  status?: string;
  error?: string;
  diff?: ContentTabDiff;
}

const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\0\r\n]/.test(v);

const bodyText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && !v.includes("\0");

export function contentTabKey(pluginId: string, view: string, key: string): string {
  return `${PLUGIN_CONTENT_EDITOR_KIND}:${JSON.stringify([pluginId, view, key])}`;
}

/** Validates an `open-content-tab` message from a plugin web view. */
export function contentTabData(pluginId: string, view: string, value: object, length: number): PluginContentEditorData {
  const m = value as Record<string, unknown>;
  const { title, key = title, language, fileName, content, readOnly = false, actions = [] } = m;
  if (
    length > 2 << 20 ||
    !text(title, 256) ||
    !text(key, 128) ||
    (language !== undefined && !text(language, 64)) ||
    (fileName !== undefined && (!text(fileName, 256) || /[/\\]/.test(fileName))) ||
    !bodyText(content, 1 << 20) ||
    typeof readOnly !== "boolean" ||
    !Array.isArray(actions) ||
    actions.length > 16
  ) {
    throw new Error(tx("Invalid content editor configuration"));
  }
  const parsedActions: PluginContentActionSpec[] = [];
  const ids = new Set<string>();
  let saveCount = 0;
  for (const raw of actions) {
    if (!raw || typeof raw !== "object") throw new Error(tx("Invalid content editor configuration"));
    const a = raw as Record<string, unknown>;
    if (
      !text(a.id, 64) ||
      ids.has(a.id) ||
      !text(a.label, 128) ||
      (a.icon !== undefined && (typeof a.icon !== "string" || !BUILTIN_ICONS.has(a.icon))) ||
      (a.primary !== undefined && typeof a.primary !== "boolean") ||
      (a.save !== undefined && typeof a.save !== "boolean")
    ) {
      throw new Error(tx("Invalid content editor configuration"));
    }
    ids.add(a.id);
    if (a.save === true) saveCount++;
    if (saveCount > 1) throw new Error(tx("Invalid content editor configuration"));
    parsedActions.push({
      id: a.id,
      label: a.label,
      icon: a.icon as IconName | undefined,
      primary: a.primary === true ? true : undefined,
      save: a.save === true ? true : undefined,
    });
  }
  const plugin = usePlugins.getState().plugins.find((p) => p.id === pluginId);
  if (!plugin?.enabled) {
    throw new Error(tx("Invalid content editor configuration"));
  }
  return {
    pluginId,
    view,
    key,
    title,
    language: language as string | undefined,
    fileName: fileName as string | undefined,
    content,
    readOnly,
    actions: parsedActions,
  };
}

// --- Frame & backend action dispatch ----------------------------------------------

const frameSenders = new Map<string, Set<(message: object) => void>>();
const pendingRequests = new Map<
  string,
  {
    pluginId: string;
    resolve: (reply: ContentTabReply) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let nextReqSeq = 1;

export function registerContentTabSender(pluginId: string, view: string, send: (message: object) => void): () => void {
  const k = `${pluginId}/${view}`;
  let set = frameSenders.get(k);
  if (!set) {
    set = new Set();
    frameSenders.set(k, set);
  }
  set.add(send);
  const offBackend = onViewMessage(pluginId, view, (raw) => {
    handleContentTabReplyText(pluginId, raw);
  });
  return () => {
    offBackend();
    set?.delete(send);
    if (set?.size === 0) frameSenders.delete(k);
  };
}

function validDiff(v: unknown): ContentTabDiff | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") throw new Error(tx("Invalid content editor configuration"));
  const d = v as Record<string, unknown>;
  if (
    !bodyText(d.left, 1 << 20) ||
    !bodyText(d.right, 1 << 20) ||
    (d.leftLabel !== undefined && !text(d.leftLabel, 128)) ||
    (d.rightLabel !== undefined && !text(d.rightLabel, 128)) ||
    (d.title !== undefined && !text(d.title, 256))
  ) {
    throw new Error(tx("Invalid content editor configuration"));
  }
  return {
    left: d.left,
    right: d.right,
    leftLabel: d.leftLabel as string | undefined,
    rightLabel: d.rightLabel as string | undefined,
    title: d.title as string | undefined,
  };
}

export function handleContentTabReplyText(pluginId: string, rawText: string): boolean {
  if (!rawText.startsWith("{") || !rawText.includes('"content-tab-reply"')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { op?: unknown }).op !== "content-tab-reply") {
    return false;
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.requestId !== "string") return true;
  const entry = pendingRequests.get(m.requestId);
  if (!entry || entry.pluginId !== pluginId) return true;
  pendingRequests.delete(m.requestId);
  clearTimeout(entry.timer);
  try {
    if (
      (m.content !== undefined && !bodyText(m.content, 1 << 20)) ||
      (m.saved !== undefined && typeof m.saved !== "boolean") ||
      (m.readOnly !== undefined && typeof m.readOnly !== "boolean") ||
      (m.status !== undefined && (typeof m.status !== "string" || m.status.length > 512)) ||
      (m.error !== undefined && (typeof m.error !== "string" || m.error.length > 1024))
    ) {
      throw new Error(tx("Invalid content editor configuration"));
    }
    const diff = validDiff(m.diff);
    entry.resolve({
      op: "content-tab-reply",
      requestId: m.requestId,
      content: m.content as string | undefined,
      saved: m.saved as boolean | undefined,
      readOnly: m.readOnly as boolean | undefined,
      status: m.status as string | undefined,
      error: m.error as string | undefined,
      diff,
    });
  } catch (err) {
    entry.reject(err instanceof Error ? err : new Error(String(err)));
  }
  return true;
}

export function dispatchContentTabAction(
  data: PluginContentEditorData,
  action: string,
  content: string,
  timeoutMs = 15_000,
): Promise<ContentTabReply> {
  const plugin = usePlugins.getState().plugins.find((p) => p.id === data.pluginId);
  if (!plugin?.enabled) {
    return Promise.reject(new Error(tx("Invalid content editor configuration")));
  }
  const requestId = `ct-${nextReqSeq++}`;
  const payload = JSON.stringify({
    op: "content-tab-action",
    requestId,
    key: data.key,
    action,
    content,
  });
  return new Promise<ContentTabReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(tx("Content editor action timed out")));
    }, timeoutMs);
    pendingRequests.set(requestId, { pluginId: data.pluginId, resolve, reject, timer });

    const senders = frameSenders.get(`${data.pluginId}/${data.view}`);
    if (senders) {
      for (const send of senders) send({ text: payload });
    }
    if (plugin.hasCode) {
      let offOnce = () => {};
      offOnce = onViewMessage(data.pluginId, data.view, (raw) => {
        if (handleContentTabReplyText(data.pluginId, raw)) offOnce();
      });
      pluginsBackend()
        .viewEvent(data.pluginId, data.view, { kind: "message", text: payload }, null)
        .catch((err: unknown) => {
          offOnce();
          if ((!senders || senders.size === 0) && pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
    } else if (!senders || senders.size === 0) {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      reject(new Error(tx("Content editor action timed out")));
    }
  });
}

export function cancelPluginContentRequests(pluginId?: string) {
  for (const [id, entry] of pendingRequests) {
    if (!pluginId || entry.pluginId === pluginId) {
      pendingRequests.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(tx("Content editor action timed out")));
    }
  }
}
