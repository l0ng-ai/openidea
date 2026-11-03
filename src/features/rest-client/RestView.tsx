import { useEffect, useMemo, useRef, useState } from "react";

import { EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { SplitGroup, SplitPanel, SplitHandle } from "@/ui/Splitter";
import {
  buildHeaders,
  bodyPayload,
  clone,
  colorizeHtml,
  colorizeJson,
  createTabFromRequest,
  enabledRows,
  escapeHtml,
  envVariablesMap,
  executeRequest,
  formatBytes,
  loadState,
  methodColor,
  resolveVariables,
  runPostmanScript,
  saveState,
  uid,
  type AuthConfig,
  type BodyConfig,
  type Collection,
  type ConsoleLog,
  type Environment,
  type KvRow,
  type RequestRecord,
  type RestState,
  type Tab,
  type HistoryEntry,
} from "./model";
import { tx } from "@/platform/i18n";
import styles from "./RestView.module.css";
import { Checkbox, Icon, Input, Select } from "@/ui";

const EMPTY_AUTH: AuthConfig = {
  type: "none",
  bearer: "",
  username: "",
  password: "",
  apiKeyKey: "X-API-Key",
  apiKeyVal: "",
  apiKeyIn: "header",
};

const EMPTY_BODY: BodyConfig = {
  mode: "none",
  rawLang: "json",
  raw: "",
  formData: [],
  urlencoded: [],
  graphqlQuery: "",
  graphqlVars: "{}",
  binaryName: null,
};

const DEFAULT_REQUEST: RequestRecord = {
  id: "req-new",
  name: "Untitled Request",
  method: "GET",
  url: "https://jsonplaceholder.typicode.com/users",
  params: [],
  auth: { ...EMPTY_AUTH },
  headers: [
    {
      enabled: true,
      key: "Accept",
      value: "application/json",
      description: "",
    },
  ],
  body: { ...EMPTY_BODY },
  scripts: { preRequest: "", postResponse: "" },
  settings: { timeout: 15000, followRedirects: true, disableCache: false },
};

/* Crisp 14px/16px Lucide-compatible inline SVG icons for developer controls */
function UiIcon({
  name,
  size = 14,
  className,
}: {
  name:
    | "folder"
    | "layers"
    | "clock"
    | "box"
    | "git-branch"
    | "plus"
    | "trash"
    | "send"
    | "save"
    | "copy"
    | "terminal"
    | "search"
    | "play"
    | "download"
    | "wand"
    | "sun"
    | "moon"
    | "sidebar"
    | "check"
    | "alert";
  size?: number;
  className?: string;
}) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.85,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };

  switch (name) {
    case "folder":
      return (
        <svg {...props}>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      );
    case "layers":
      return (
        <svg {...props}>
          <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
          <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
          <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
        </svg>
      );
    case "clock":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "box":
      return (
        <svg {...props}>
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      );
    case "git-branch":
      return (
        <svg {...props}>
          <line x1="6" x2="6" y1="3" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      );
    case "plus":
      return (
        <svg {...props}>
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
      );
    case "trash":
      return (
        <svg {...props}>
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      );
    case "send":
      return (
        <svg {...props}>
          <path d="m22 2-7 20-4-9-9-4Z" />
          <path d="M22 2 11 13" />
        </svg>
      );
    case "save":
      return (
        <svg {...props}>
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      );
    case "copy":
      return (
        <svg {...props}>
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...props}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      );
    case "search":
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "play":
      return (
        <svg {...props}>
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
      );
    case "download":
      return (
        <svg {...props}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
      );
    case "wand":
      return (
        <svg {...props}>
          <path d="m15 4-1 1 4 4 1-1a2.83 2.83 0 1 0-4-4Z" />
          <path d="m13 6-8.5 8.5a2.12 2.12 0 1 0 3 3L16 9" />
        </svg>
      );
    case "sun":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      );
    case "moon":
      return (
        <svg {...props}>
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      );
    case "sidebar":
      return (
        <svg {...props}>
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      );
    case "check":
      return (
        <svg {...props}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "alert":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" x2="12" y1="8" y2="12" />
          <line x1="12" x2="12.01" y1="16" y2="16" />
        </svg>
      );
  }
}

function prettyMarkup(markup: string): string {
  const levelIndent = (level: number) => "  ".repeat(Math.max(0, level));
  let level = 0;
  const lines: string[] = [];
  const tokens = markup.match(/<\/?[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (/^<\//.test(trimmed)) level = Math.max(0, level - 1);
    lines.push(`${levelIndent(level)}${trimmed}`);
    const isVoid = /^<(br|hr|img|input|meta|link|source|embed|col|area|base|wbr)\b/i.test(trimmed);
    const isClosing = /\/>$/.test(trimmed) || /^<\//.test(trimmed);
    const isOpening = /^<[^/!?]/.test(trimmed);
    if (isOpening && !isVoid && !isClosing) level += 1;
  }
  return lines.join("\n");
}

export function RestView() {
  const [state, setState] = useState<RestState>(() => loadState());
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [curlText, setCurlText] = useState("");
  const [curlOpen, setCurlOpen] = useState(false);
  const [responseSearch, setResponseSearch] = useState("");
  const [copiedResponse, setCopiedResponse] = useState(false);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0] ?? null,
    [state.tabs, state.activeTabId],
  );
  const activeEnv = useMemo(
    () => state.environments.find((e) => e.id === state.activeEnvId) ?? null,
    [state.environments, state.activeEnvId],
  );
  const activeCollection = useMemo(() => {
    if (!activeTab?.collectionId) return null;
    return state.collections.find((c) => c.id === activeTab.collectionId) ?? null;
  }, [activeTab, state.collections]);

  function patchState(updater: (prev: RestState) => RestState) {
    setState((prev) => updater(prev));
  }

  function updateTab(tabId: string, updater: (tab: Tab) => Tab) {
    patchState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === tabId ? updater(t) : t)),
    }));
  }

  function updateCollection(collectionId: string, updater: (collection: Collection) => Collection) {
    patchState((prev) => ({
      ...prev,
      collections: prev.collections.map((c) => (c.id === collectionId ? updater(c) : c)),
    }));
  }

  function updateEnvironment(envId: string, updater: (env: Environment) => Environment) {
    patchState((prev) => ({
      ...prev,
      environments: prev.environments.map((e) => (e.id === envId ? updater(e) : e)),
    }));
  }

  function addCollection() {
    const existing = state.collections.map((c) => c.name);
    let name = "New Collection";
    if (existing.includes(name)) {
      let i = 2;
      while (existing.includes(`${name} ${i}`)) i += 1;
      name = `${name} ${i}`;
    }
    const col: Collection = {
      id: uid("col"),
      name,
      expanded: true,
      requests: [],
    };
    patchState((prev) => ({
      ...prev,
      collections: [...prev.collections, col],
    }));
  }

  function deleteCollection(collectionId: string) {
    patchState((prev) => ({
      ...prev,
      collections: prev.collections.filter((c) => c.id !== collectionId),
      tabs: prev.tabs.filter((t) => t.collectionId !== collectionId),
    }));
  }

  function addRequest(collectionId: string) {
    const col = state.collections.find((c) => c.id === collectionId);
    if (!col) return;
    const existing = col.requests.map((r) => r.name);
    let name = "New Request";
    if (existing.includes(name)) {
      let i = 2;
      while (existing.includes(`${name} ${i}`)) i += 1;
      name = `${name} ${i}`;
    }
    const req: RequestRecord = {
      ...clone(DEFAULT_REQUEST),
      id: uid("req"),
      name,
    };
    updateCollection(collectionId, (c) => ({
      ...c,
      expanded: true,
      requests: [...c.requests, req],
    }));
    openRequestInTab(req, collectionId);
  }

  function deleteRequest(collectionId: string, requestId: string) {
    updateCollection(collectionId, (c) => ({
      ...c,
      requests: c.requests.filter((r) => r.id !== requestId),
    }));
    patchState((prev) => ({
      ...prev,
      tabs: prev.tabs.filter((t) => t.requestId !== requestId),
    }));
  }

  function openRequestInTab(req: RequestRecord, collectionId: string | null) {
    const existing = state.tabs.find((t) => t.requestId === req.id);
    if (existing) {
      patchState((prev) => ({ ...prev, activeTabId: existing.id }));
      return;
    }
    const tab = createTabFromRequest(req, collectionId);
    patchState((prev) => ({
      ...prev,
      tabs: [...prev.tabs, tab],
      activeTabId: tab.id,
    }));
  }

  function newTab() {
    const req: RequestRecord = { ...clone(DEFAULT_REQUEST), id: uid("req") };
    const tab = createTabFromRequest(req, null);
    patchState((prev) => ({
      ...prev,
      tabs: [...prev.tabs, tab],
      activeTabId: tab.id,
    }));
  }

  function closeTab(tabId: string) {
    patchState((prev) => {
      const next = prev.tabs.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        const req = { ...clone(DEFAULT_REQUEST), id: uid("req") };
        const tab = createTabFromRequest(req, null);
        return { ...prev, tabs: [tab], activeTabId: tab.id };
      }
      const active = prev.activeTabId === tabId ? next[next.length - 1]!.id : prev.activeTabId;
      return { ...prev, tabs: next, activeTabId: active };
    });
  }

  function updateActiveTab(updater: (t: Tab) => Tab) {
    if (!activeTab) return;
    updateTab(activeTab.id, updater);
  }

  function patchActiveRequest<K extends keyof RequestRecord>(field: K, value: RequestRecord[K]) {
    updateActiveTab((t) => ({
      ...t,
      dirty: true,
      request: { ...t.request, [field]: value } as RequestRecord,
    }));
  }

  function patchActiveAuth(patch: Partial<AuthConfig>) {
    updateActiveTab((t) => ({
      ...t,
      dirty: true,
      request: { ...t.request, auth: { ...t.request.auth, ...patch } },
    }));
  }

  function patchActiveBody(patch: Partial<BodyConfig>) {
    updateActiveTab((t) => ({
      ...t,
      dirty: true,
      request: { ...t.request, body: { ...t.request.body, ...patch } },
    }));
  }

  function addKv(kind: "params" | "headers" | "formData" | "urlencoded") {
    const row: KvRow = { enabled: true, key: "", value: "", description: "" };
    updateActiveTab((t) => {
      if (kind === "params") {
        const nextRows = [...t.request.params, row];
        return {
          ...t,
          dirty: true,
          request: {
            ...t.request,
            params: nextRows,
            url: serializeParamsIntoUrl(nextRows, t.request.url),
          },
        };
      }
      if (kind === "headers")
        return {
          ...t,
          dirty: true,
          request: { ...t.request, headers: [...t.request.headers, row] },
        };
      const body = { ...t.request.body };
      if (kind === "formData") body.formData = [...body.formData, row];
      if (kind === "urlencoded") body.urlencoded = [...body.urlencoded, row];
      return { ...t, dirty: true, request: { ...t.request, body } };
    });
  }

  function patchKv(kind: "params" | "headers", id: number, patch: Partial<KvRow>) {
    updateActiveTab((t) => {
      const nextRows = t.request[kind].map((r, i) => (i === id ? { ...r, ...patch } : r));
      const nextRequest: RequestRecord = {
        ...t.request,
        [kind]: nextRows,
      } as RequestRecord;
      if (kind === "params") nextRequest.url = serializeParamsIntoUrl(nextRows, t.request.url);
      return { ...t, dirty: true, request: nextRequest };
    });
  }

  function removeKv(kind: "params" | "headers", id: number) {
    updateActiveTab((t) => {
      const nextRows = t.request[kind].filter((_, i) => i !== id);
      const nextRequest: RequestRecord = {
        ...t.request,
        [kind]: nextRows,
      } as RequestRecord;
      if (kind === "params") nextRequest.url = serializeParamsIntoUrl(nextRows, t.request.url);
      return { ...t, dirty: true, request: nextRequest };
    });
  }

  function saveActiveRequest() {
    if (!activeTab || !activeTab.collectionId) return;
    const colId = activeTab.collectionId;
    const reqId = activeTab.requestId;
    updateCollection(colId, (c) => ({
      ...c,
      requests: c.requests.map((r) => (r.id === reqId ? clone(activeTab.request) : r)),
    }));
    updateTab(activeTab.id, (t) => ({ ...t, dirty: false }));
  }

  function duplicateActiveRequest() {
    if (!activeTab) return;
    const colId = activeTab.collectionId;
    const copy = clone(activeTab.request);
    copy.id = uid("req");
    copy.name = `${activeTab.request.name} (copy)`;
    if (colId) {
      updateCollection(colId, (c) => ({
        ...c,
        expanded: true,
        requests: [...c.requests, copy],
      }));
    }
    openRequestInTab(copy, colId);
  }

  async function sendActiveRequest() {
    if (!activeTab) return;
    updateTab(activeTab.id, (t) => ({ ...t, sending: true, error: null }));
    const result = await executeRequest({ ...activeTab, request: activeTab.request }, activeEnv);
    updateTab(activeTab.id, (t) => ({
      ...t,
      sending: false,
      response: result.response,
      error: result.error,
      testResults: result.tests,
    }));

    const entry: HistoryEntry = {
      id: uid("hist"),
      timestamp: Date.now(),
      method: activeTab.request.method,
      url: activeTab.request.url,
      status: result.response?.status ?? null,
      timeMs: result.response?.timeMs ?? 0,
      sizeBytes: result.response?.sizeBytes ?? 0,
      response: result.response,
      error: result.error,
    };
    patchState((prev) => {
      const logs: ConsoleLog[] = result.logs.map((l) => ({ ...l }));
      if (result.error)
        logs.unshift({
          id: uid("log"),
          level: "error",
          message: result.error,
          timestamp: Date.now(),
        });
      return {
        ...prev,
        history: [entry, ...prev.history].slice(0, 200),
        consoleLogs: [...logs.reverse(), ...prev.consoleLogs].slice(0, 500),
      };
    });
  }

  function copyCurl() {
    if (!activeTab) return;
    const vars = envVariablesMap(activeEnv);
    const headers = buildHeaders(activeTab.request.headers, activeTab.request.auth, vars);
    const url = resolveVariables(activeTab.request.url, vars);
    let cmd = `curl -X ${activeTab.request.method} "${url}"`;
    for (const [k, v] of Object.entries(headers)) cmd += ` \\\n  -H "${k}: ${v}"`;
    const body = bodyPayload(activeTab.request.body, headers, vars);
    if (body) cmd += ` \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
    setCurlText(cmd);
    setCurlOpen(true);
    try {
      void navigator.clipboard.writeText(cmd);
    } catch {
      /* ignore */
    }
  }

  function addEnvironment() {
    const name = "New Environment";
    const env: Environment = { id: uid("env"), name, variables: [] };
    patchState((prev) => ({
      ...prev,
      environments: [...prev.environments, env],
      activeEnvId: prev.activeEnvId ?? env.id,
    }));
  }

  function deleteEnvironment(envId: string) {
    patchState((prev) => {
      const envs = prev.environments.filter((e) => e.id !== envId);
      return {
        ...prev,
        environments: envs,
        activeEnvId: envs.length ? envs[0]!.id : null,
      };
    });
  }

  function addEnvVariable(envId: string) {
    updateEnvironment(envId, (e) => ({
      ...e,
      variables: [...e.variables, { enabled: true, key: "", value: "", description: "" }],
    }));
  }

  function removeEnvVariable(envId: string, idx: number) {
    updateEnvironment(envId, (e) => ({
      ...e,
      variables: e.variables.filter((_, i) => i !== idx),
    }));
  }

  function patchEnvVariable(envId: string, idx: number, patch: Partial<KvRow>) {
    updateEnvironment(envId, (e) => ({
      ...e,
      variables: e.variables.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  }

  function runPreScript() {
    if (!activeTab) return;
    const vars = envVariablesMap(activeEnv);
    const res = runPostmanScript(activeTab.request.scripts.preRequest, "pre", {
      request: activeTab.request,
      envVars: vars,
      env: activeEnv,
    });
    patchState((prev) => ({
      ...prev,
      consoleLogs: [...res.logs, ...prev.consoleLogs].slice(0, 500),
    }));
  }

  function parseParamsFromUrlQuery(query: string): KvRow[] {
    if (!query.trim()) return [];
    const rows: KvRow[] = [];
    for (const pair of query.split("&")) {
      if (!pair) continue;
      const [rawKey, ...rest] = pair.split("=");
      const rawValue = rest.join("=");
      rows.push({
        enabled: true,
        key: rawKey ?? "",
        value: rawValue ?? "",
        description: "",
      });
    }
    return rows;
  }

  function serializeParamsIntoUrl(params: KvRow[], baseUrl: string): string {
    const base = baseUrl.split("?")[0] ?? baseUrl;
    const q = params
      .filter((r) => r.enabled && (r.key || r.value || r.description))
      .map((r) => `${r.key}=${r.value}`)
      .join("&");
    return q ? `${base}?${q}` : base;
  }

  function handleUrlChange(nextUrl: string) {
    const qIdx = nextUrl.indexOf("?");
    if (qIdx < 0) {
      patchActiveRequest("url", nextUrl);
      return;
    }
    const query = nextUrl.slice(qIdx + 1);
    const parsed = parseParamsFromUrlQuery(query);
    updateActiveTab((t) => ({
      ...t,
      dirty: true,
      request: {
        ...t.request,
        url: nextUrl,
        params: parsed.length ? parsed : t.request.params,
      },
    }));
  }

  const railItems: {
    id: RestState["activeRail"];
    label: string;
    icon: "folder" | "layers" | "clock" | "box" | "git-branch";
  }[] = [
    { id: "collections", label: "Collections", icon: "folder" },
    { id: "environments", label: "Environments", icon: "layers" },
    { id: "history", label: "History", icon: "clock" },
  ];

  const configTabs: { id: RestState["activeConfigTab"]; label: string }[] = [
    { id: "params", label: "Params" },
    { id: "auth", label: "Authorization" },
    { id: "headers", label: "Headers" },
    { id: "body", label: "Body" },
    { id: "scripts", label: "Scripts" },
    { id: "settings", label: "Settings" },
  ];

  const resTabs: { id: RestState["activeResTab"]; label: string }[] = [
    { id: "body", label: "Body" },
    { id: "cookies", label: "Cookies" },
    { id: "headers", label: "Headers" },
    { id: "tests", label: "Test Results" },
  ];

  const resp = activeTab?.response ?? null;

  const respContentType = (resp?.headers ?? []).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const respIsHtml = /html/i.test(respContentType);

  const formattedResponseText = useMemo(() => {
    if (!resp) return "";
    const text =
      state.resViewMode === "pretty" && resp.isJson
        ? JSON.stringify(resp.json, null, 2)
        : state.resViewMode === "pretty" && respIsHtml
          ? prettyMarkup(resp.bodyText)
          : resp.bodyText;
    if (!responseSearch.trim()) return text;
    return text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(responseSearch.toLowerCase()))
      .join("\n");
  }, [resp, state.resViewMode, responseSearch, respIsHtml]);

  const responseLineCount = useMemo(() => {
    if (!formattedResponseText) return 0;
    return Math.min(formattedResponseText.split("\n").length, 500);
  }, [formattedResponseText]);

  return (
    <div className={styles.root}>
      <div className={styles.shell}>
        {/* Primary Vertical Activity Rail */}
        <nav className={styles.activityRail} aria-label="Workspace Navigation">
          <div className={styles.railGroup}>
            {railItems.map((item) => {
              const isActive = state.activeRail === item.id && !state.sidebarCollapsed;
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  className={`${styles.railItem} ${isActive ? styles.railItemActive : ""}`}
                  onClick={() =>
                    patchState((prev) => ({
                      ...prev,
                      activeRail: item.id,
                      sidebarCollapsed: prev.activeRail === item.id ? !prev.sidebarCollapsed : false,
                    }))
                  }
                >
                  <UiIcon name={item.icon} size={16} />
                </button>
              );
            })}
          </div>
          <div className={styles.railGroup}>
            <button
              type="button"
              title={state.sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
              aria-label="Toggle Sidebar"
              className={styles.railItem}
              onClick={() =>
                patchState((prev) => ({
                  ...prev,
                  sidebarCollapsed: !prev.sidebarCollapsed,
                }))
              }
            >
              <UiIcon name="sidebar" size={15} />
            </button>
          </div>
        </nav>

        {/* Secondary Sidebar Explorer */}
        {!state.sidebarCollapsed && (
          <aside className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
              <span className={styles.sidebarTitle}>
                {state.activeRail === "collections"
                  ? state.workspaceName
                  : state.activeRail === "environments"
                    ? "Environments"
                    : "Request History"}
              </span>
              {state.activeRail === "collections" && (
                <button type="button" className={styles.btn} onClick={addCollection} title="Create New Collection">
                  <UiIcon name="plus" size={12} />
                  <span>New</span>
                </button>
              )}
              {state.activeRail === "environments" && (
                <button type="button" className={styles.btn} onClick={addEnvironment} title="Create New Environment">
                  <UiIcon name="plus" size={12} />
                  <span>New</span>
                </button>
              )}
            </div>

            <div className={styles.sidebarFilterRow}>
              <div className={styles.searchBox}>
                <UiIcon name="search" size={12} className={styles.searchIcon} />
                <Input
                  className={styles.sidebarFilter}
                  value={state.sidebarFilter}
                  onChange={(e) =>
                    patchState((prev) => ({
                      ...prev,
                      sidebarFilter: e.target.value,
                    }))
                  }
                  placeholder={tx`Filter ${state.activeRail}...`}
                />
              </div>
            </div>

            <div className={styles.sidebarList}>
              {state.activeRail === "collections" && (
                <>
                  {state.collections
                    .filter(
                      (c) =>
                        c.name.toLowerCase().includes(state.sidebarFilter.toLowerCase()) ||
                        c.requests.some((r) => r.name.toLowerCase().includes(state.sidebarFilter.toLowerCase())),
                    )
                    .map((col) => (
                      <div key={col.id} className={styles.collectionGroup}>
                        <div className={styles.collectionRow}>
                          <button
                            type="button"
                            className={styles.chevronBtn}
                            aria-label={col.expanded ? "Collapse collection" : "Expand collection"}
                            onClick={() =>
                              updateCollection(col.id, (c) => ({
                                ...c,
                                expanded: !c.expanded,
                              }))
                            }
                          >
                            {col.expanded ? (
                              <Icon name="chevron-down" size={12} />
                            ) : (
                              <Icon name="chevron-right" size={12} />
                            )}
                          </button>
                          <button
                            type="button"
                            className={styles.collectionNameBtn}
                            onClick={() =>
                              updateCollection(col.id, (c) => ({
                                ...c,
                                expanded: !c.expanded,
                              }))
                            }
                          >
                            <UiIcon name="folder" size={13} />
                            <span>{col.name}</span>
                          </button>
                          <div className={styles.collectionActions}>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              title="Add Request"
                              aria-label={`Add request to ${col.name}`}
                              onClick={() => addRequest(col.id)}
                            >
                              <UiIcon name="plus" size={13} />
                            </button>
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDestructive}`}
                              title="Delete Collection"
                              aria-label={`Delete ${col.name}`}
                              onClick={() => deleteCollection(col.id)}
                            >
                              <UiIcon name="trash" size={13} />
                            </button>
                          </div>
                        </div>
                        {col.expanded && (
                          <div className={styles.requestList}>
                            {col.requests
                              .filter((r) => r.name.toLowerCase().includes(state.sidebarFilter.toLowerCase()))
                              .map((req) => (
                                <button
                                  key={req.id}
                                  type="button"
                                  className={`${styles.requestRow} ${activeTab?.requestId === req.id ? styles.requestRowActive : ""}`}
                                  onClick={() => openRequestInTab(req, col.id)}
                                >
                                  <span className={styles.methodTag} style={{ color: methodColor(req.method) }}>
                                    {req.method}
                                  </span>
                                  <span className={styles.requestName}>{req.name}</span>
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    title="Delete Request"
                                    aria-label={`Delete ${req.name}`}
                                    className={`${styles.iconBtn} ${styles.iconBtnDestructive} ${styles.requestDeleteBtn}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      deleteRequest(col.id, req.id);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.stopPropagation();
                                        deleteRequest(col.id, req.id);
                                      }
                                    }}
                                  >
                                    <Icon name="close" size={11} />
                                  </span>
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                    ))}
                </>
              )}

              {state.activeRail === "environments" && (
                <>
                  {state.environments
                    .filter((env) => env.name.toLowerCase().includes(state.sidebarFilter.toLowerCase()))
                    .map((env) => {
                      const isActive = state.activeEnvId === env.id;
                      return (
                        <div key={env.id} className={`${styles.envBlock} ${isActive ? styles.envBlockActive : ""}`}>
                          <div className={styles.envRow}>
                            <button
                              type="button"
                              className={`${styles.envNameBtn} ${isActive ? styles.envNameBtnActive : ""}`}
                              onClick={() =>
                                patchState((prev) => ({
                                  ...prev,
                                  activeEnvId: env.id,
                                }))
                              }
                            >
                              <UiIcon name="layers" size={13} />
                              <span>{env.name}</span>
                            </button>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              title="Add Variable"
                              onClick={() => addEnvVariable(env.id)}
                            >
                              <UiIcon name="plus" size={13} />
                            </button>
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDestructive}`}
                              title="Delete Environment"
                              onClick={() => deleteEnvironment(env.id)}
                            >
                              <UiIcon name="trash" size={13} />
                            </button>
                          </div>
                          {isActive && (
                            <div className={styles.envVars}>
                              {env.variables.map((row, idx) => (
                                <div key={idx} className={styles.envVarRow}>
                                  <Checkbox
                                    checked={row.enabled}
                                    className={styles.kvCheck}
                                    aria-label={row.enabled ? "Disable variable" : "Enable variable"}
                                    onChange={(checked) =>
                                      patchEnvVariable(env.id, idx, {
                                        enabled: checked,
                                      })
                                    }
                                  />
                                  <Input
                                    className={styles.kvInput}
                                    variant="bare"
                                    value={row.key}
                                    onChange={(e) =>
                                      patchEnvVariable(env.id, idx, {
                                        key: e.target.value,
                                      })
                                    }
                                    placeholder="variable"
                                  />
                                  <Input
                                    className={styles.kvInput}
                                    variant="bare"
                                    value={row.value}
                                    onChange={(e) =>
                                      patchEnvVariable(env.id, idx, {
                                        value: e.target.value,
                                      })
                                    }
                                    placeholder="value"
                                  />
                                  <button
                                    type="button"
                                    className={`${styles.iconBtn} ${styles.iconBtnDestructive}`}
                                    title="Remove Variable"
                                    onClick={() => removeEnvVariable(env.id, idx)}
                                  >
                                    <Icon name="close" size={11} />
                                  </button>
                                </div>
                              ))}
                              {env.variables.length === 0 && (
                                <div className={styles.emptyHint}>No variables configured.</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </>
              )}

              {state.activeRail === "history" && (
                <>
                  {state.history
                    .filter((h) => h.url.toLowerCase().includes(state.sidebarFilter.toLowerCase()))
                    .map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={styles.historyRow}
                        onClick={() => {
                          const req = clone(activeTab?.request ?? DEFAULT_REQUEST);
                          req.method = entry.method;
                          req.url = entry.url;
                          const tab = createTabFromRequest(req, null);
                          tab.response = entry.response;
                          tab.error = entry.error;
                          patchState((prev) => ({
                            ...prev,
                            tabs: [...prev.tabs, tab],
                            activeTabId: tab.id,
                          }));
                        }}
                      >
                        <div className={styles.historyTop}>
                          <span
                            style={{
                              color: methodColor(entry.method),
                              fontWeight: 700,
                              fontSize: 10,
                            }}
                          >
                            {entry.method}
                          </span>
                          <span className={styles.historyMeta}>
                            <span>{entry.status ?? "ERR"}</span>
                            <span>·</span>
                            <span>{entry.timeMs} ms</span>
                            <span>·</span>
                            <span>{formatBytes(entry.sizeBytes)}</span>
                          </span>
                        </div>
                        <span className={styles.historyUrl}>{entry.url}</span>
                      </button>
                    ))}
                  {state.history.length === 0 && (
                    <div className={styles.emptyState}>
                      <div className={styles.emptyStateIcon}>
                        <UiIcon name="clock" size={16} />
                      </div>
                      <span className={styles.emptyStateTitle}>No request history</span>
                      <span>Sent requests will appear here for quick replay.</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
        )}

        {/* Primary Request & Response Workspace */}
        <main className={styles.main}>
          <div className={styles.topBar}>
            <div className={styles.tabBar}>
              <div className={styles.tabsScroll}>
                {state.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`${styles.reqTab} ${tab.id === state.activeTabId ? styles.reqTabActive : ""}`}
                    onClick={() => patchState((prev) => ({ ...prev, activeTabId: tab.id }))}
                  >
                    <span
                      style={{
                        color: methodColor(tab.request.method),
                        fontWeight: 700,
                        fontSize: 10,
                        fontFamily: "var(--font-mono-code)",
                      }}
                    >
                      {tab.request.method}
                    </span>
                    <span className={styles.tabLabel}>{tab.request.name}</span>
                    {tab.dirty && <span className={styles.dirtyDot} title="Unsaved changes" />}
                    {state.tabs.length > 1 && (
                      <span
                        role="button"
                        tabIndex={0}
                        title="Close Tab"
                        className={styles.tabClose}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(tab.id);
                        }}
                      >
                        <Icon name="close" size={11} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={styles.newTabBtn}
                onClick={newTab}
                title="New Request Tab"
                aria-label="New Request Tab"
              >
                <UiIcon name="plus" size={14} />
              </button>
            </div>

            <div className={styles.topBarRight}>
              <div className={styles.envSelectWrap}>
                <Select
                  className={styles.envSelect}
                  value={state.activeEnvId ?? ""}
                  options={[
                    { value: "", label: "No environment" },
                    ...state.environments.map((env) => ({
                      value: env.id,
                      label: env.name,
                    })),
                  ]}
                  onChange={(v) =>
                    patchState((prev) => ({
                      ...prev,
                      activeEnvId: v || null,
                    }))
                  }
                />
              </div>
            </div>
          </div>

          {activeTab && (
            <>
              {/* Request Context Bar */}
              <div className={styles.requestHeader}>
                <div className={styles.breadcrumbGroup}>
                  <span className={styles.methodBadge} style={{ color: methodColor(activeTab.request.method) }}>
                    {activeTab.request.method}
                  </span>
                  <span className={styles.colLabel}>{activeCollection?.name ?? "Scratchpad"}</span>
                  <span className={styles.slash}>/</span>
                  <Input
                    className={styles.nameInput}
                    value={activeTab.request.name}
                    onChange={(e) => patchActiveRequest("name", e.target.value)}
                    placeholder="Request name"
                  />
                </div>
                <div className={styles.headerActions}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={saveActiveRequest}
                    disabled={!activeTab.collectionId}
                    title="Save changes to collection"
                  >
                    <UiIcon name="save" size={12} />
                    <span>Save</span>
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={duplicateActiveRequest}
                    title="Duplicate request"
                  >
                    <UiIcon name="copy" size={12} />
                    <span>Duplicate</span>
                  </button>
                  <button type="button" className={styles.btn} onClick={copyCurl} title="Export as cURL command">
                    <UiIcon name="terminal" size={12} />
                    <span>cURL</span>
                  </button>
                </div>
              </div>

              {/* URL Execution Bar */}
              <div className={styles.urlBar}>
                <div className={styles.urlComposer}>
                  <Select
                    variant="ghost"
                    className={styles.methodSelect}
                    style={{ color: methodColor(activeTab.request.method) }}
                    value={activeTab.request.method}
                    options={["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => ({
                      value: m,
                      label: m,
                    }))}
                    onChange={(v) => patchActiveRequest("method", v)}
                  />
                  <VariableUrlInput
                    value={activeTab.request.url}
                    env={activeEnv}
                    onChange={handleUrlChange}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void sendActiveRequest();
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className={styles.sendBtn}
                  onClick={() => void sendActiveRequest()}
                  disabled={activeTab.sending}
                >
                  <UiIcon name="send" size={13} />
                  <span>{activeTab.sending ? "Sending..." : "Send"}</span>
                </button>
              </div>

              {/* Vertical Split: Request Configuration & Response Inspector */}
              <SplitGroup orientation="vertical" className={styles.split}>
                <SplitPanel defaultSize="45%" minSize="140px">
                  <div className={styles.configPane}>
                    <div className={styles.subTabs}>
                      {configTabs.map((t) => {
                        const paramCount = enabledRows(activeTab.request.params).length;
                        const headerCount = enabledRows(activeTab.request.headers).length;
                        const hasAuth = activeTab.request.auth.type !== "none";
                        const hasBody = activeTab.request.body.mode !== "none";
                        const hasScripts = Boolean(
                          activeTab.request.scripts.preRequest.trim() || activeTab.request.scripts.postResponse.trim(),
                        );

                        return (
                          <button
                            key={t.id}
                            type="button"
                            className={`${styles.subTab} ${state.activeConfigTab === t.id ? styles.subTabActive : ""}`}
                            onClick={() =>
                              patchState((prev) => ({
                                ...prev,
                                activeConfigTab: t.id,
                              }))
                            }
                          >
                            <span>{t.label}</span>
                            {t.id === "params" && paramCount > 0 && (
                              <span className={styles.countBadge}>{paramCount}</span>
                            )}
                            {t.id === "headers" && headerCount > 0 && (
                              <span className={styles.countBadge}>{headerCount}</span>
                            )}
                            {t.id === "auth" && hasAuth && <span className={styles.activeDot} />}
                            {t.id === "body" && hasBody && <span className={styles.activeDot} />}
                            {t.id === "scripts" && hasScripts && <span className={styles.activeDot} />}
                          </button>
                        );
                      })}
                      <div className={styles.subTabTools} />
                    </div>

                    <div className={styles.configContent}>
                      {state.activeConfigTab === "params" && (
                        <>
                          <div className={styles.sectionCaption}>
                            <span>Query Parameters</span>
                            <button type="button" className={styles.btn} onClick={() => addKv("params")}>
                              <UiIcon name="plus" size={12} />
                              <span>Add</span>
                            </button>
                          </div>
                          <KvTable
                            rows={activeTab.request.params}
                            onChange={(idx, p) => patchKv("params", idx, p)}
                            onRemove={(idx) => removeKv("params", idx)}
                          />
                        </>
                      )}

                      {state.activeConfigTab === "headers" && (
                        <>
                          <div className={styles.sectionCaption}>
                            <span>Request Headers</span>
                            <button type="button" className={styles.btn} onClick={() => addKv("headers")}>
                              <UiIcon name="plus" size={12} />
                              <span>Add</span>
                            </button>
                          </div>
                          <KvTable
                            rows={activeTab.request.headers}
                            onChange={(idx, p) => patchKv("headers", idx, p)}
                            onRemove={(idx) => removeKv("headers", idx)}
                          />
                        </>
                      )}

                      {state.activeConfigTab === "auth" && (
                        <div className={styles.authPanel}>
                          <label className={styles.fieldRow}>
                            <span>Auth Type</span>
                            <Select
                              value={activeTab.request.auth.type}
                              options={[
                                { value: "none", label: "No Auth" },
                                { value: "bearer", label: "Bearer Token" },
                                { value: "basic", label: "Basic Auth" },
                                { value: "apikey", label: "API Key" },
                              ]}
                              onChange={(v) =>
                                patchActiveAuth({
                                  type: v as AuthConfig["type"],
                                })
                              }
                            />
                          </label>
                          {activeTab.request.auth.type === "bearer" && (
                            <label className={styles.fieldRow}>
                              <span>Bearer Token</span>
                              <Input
                                value={activeTab.request.auth.bearer}
                                onChange={(e) => patchActiveAuth({ bearer: e.target.value })}
                                placeholder="{{bearerToken}}"
                              />
                            </label>
                          )}
                          {activeTab.request.auth.type === "basic" && (
                            <>
                              <label className={styles.fieldRow}>
                                <span>Username</span>
                                <Input
                                  value={activeTab.request.auth.username}
                                  onChange={(e) =>
                                    patchActiveAuth({
                                      username: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className={styles.fieldRow}>
                                <span>Password</span>
                                <Input
                                  type="password"
                                  value={activeTab.request.auth.password}
                                  onChange={(e) =>
                                    patchActiveAuth({
                                      password: e.target.value,
                                    })
                                  }
                                />
                              </label>
                            </>
                          )}
                          {activeTab.request.auth.type === "apikey" && (
                            <>
                              <label className={styles.fieldRow}>
                                <span>Key</span>
                                <Input
                                  value={activeTab.request.auth.apiKeyKey}
                                  onChange={(e) =>
                                    patchActiveAuth({
                                      apiKeyKey: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className={styles.fieldRow}>
                                <span>Value</span>
                                <Input
                                  value={activeTab.request.auth.apiKeyVal}
                                  onChange={(e) =>
                                    patchActiveAuth({
                                      apiKeyVal: e.target.value,
                                    })
                                  }
                                  placeholder="{{apiKey}}"
                                />
                              </label>
                              <label className={styles.fieldRow}>
                                <span>Add to</span>
                                <Select
                                  value={activeTab.request.auth.apiKeyIn}
                                  options={[
                                    { value: "header", label: "Header" },
                                    { value: "query", label: "Query params" },
                                  ]}
                                  onChange={(v) =>
                                    patchActiveAuth({
                                      apiKeyIn: v as "header" | "query",
                                    })
                                  }
                                />
                              </label>
                            </>
                          )}
                          {activeTab.request.auth.type === "none" && (
                            <div className={styles.emptyHint}>
                              This request does not use authorization. Select an auth scheme above to include
                              credentials.
                            </div>
                          )}
                        </div>
                      )}

                      {state.activeConfigTab === "body" && (
                        <>
                          <div className={styles.bodyModes}>
                            <div className={styles.bodyModeGroup}>
                              {[
                                { v: "none", label: "none" },
                                { v: "raw", label: "raw" },
                                { v: "form-data", label: "form-data" },
                                { v: "urlencoded", label: "urlencoded" },
                                { v: "graphql", label: "graphql" },
                                { v: "binary", label: "binary" },
                              ].map((m) => (
                                <label
                                  key={m.v}
                                  className={`${styles.radioLabel} ${activeTab.request.body.mode === m.v ? styles.radioLabelActive : ""}`}
                                >
                                  <Input
                                    type="radio"
                                    name="bodyMode"
                                    checked={activeTab.request.body.mode === m.v}
                                    onChange={() =>
                                      patchActiveBody({
                                        mode: m.v as BodyConfig["mode"],
                                      })
                                    }
                                  />
                                  {m.label}
                                </label>
                              ))}
                            </div>

                            {activeTab.request.body.mode === "raw" && (
                              <div className={styles.bodyModeRight}>
                                <Select
                                  className={styles.langSelect}
                                  value={activeTab.request.body.rawLang}
                                  options={[
                                    { value: "json", label: "JSON" },
                                    { value: "text", label: "Text" },
                                    { value: "xml", label: "XML" },
                                    { value: "html", label: "HTML" },
                                  ]}
                                  onChange={(v) => patchActiveBody({ rawLang: v })}
                                />
                                <button
                                  type="button"
                                  className={styles.btn}
                                  onClick={() => {
                                    const lang = activeTab.request.body.rawLang;
                                    try {
                                      if (lang === "json") {
                                        patchActiveBody({
                                          raw: JSON.stringify(JSON.parse(activeTab.request.body.raw), null, 2),
                                        });
                                      } else if (lang === "html" || lang === "xml") {
                                        patchActiveBody({ raw: prettyMarkup(activeTab.request.body.raw) });
                                      }
                                    } catch {
                                      /* ignore invalid markup */
                                    }
                                  }}
                                >
                                  <UiIcon name="wand" size={12} />
                                  <span>Beautify</span>
                                </button>
                              </div>
                            )}
                          </div>

                          {activeTab.request.body.mode === "raw" && (
                            <BodyCodeEditor
                              lang={activeTab.request.body.rawLang}
                              value={activeTab.request.body.raw}
                              onChange={(raw) => patchActiveBody({ raw })}
                            />
                          )}

                          {activeTab.request.body.mode === "form-data" && (
                            <>
                              <div className={styles.sectionCaption}>
                                <span>Multipart Form Data</span>
                                <button type="button" className={styles.btn} onClick={() => addKv("formData")}>
                                  <UiIcon name="plus" size={12} />
                                  <span>Add</span>
                                </button>
                              </div>
                              <KvTable
                                rows={activeTab.request.body.formData}
                                onChange={(idx, p) => {
                                  const next = [...activeTab.request.body.formData];
                                  next[idx] = { ...next[idx], ...p } as KvRow;
                                  patchActiveBody({ formData: next });
                                }}
                                onRemove={(idx) => {
                                  const next = activeTab.request.body.formData.filter((_, i) => i !== idx);
                                  patchActiveBody({ formData: next });
                                }}
                              />
                            </>
                          )}

                          {activeTab.request.body.mode === "urlencoded" && (
                            <>
                              <div className={styles.sectionCaption}>
                                <span>x-www-form-urlencoded</span>
                                <button type="button" className={styles.btn} onClick={() => addKv("urlencoded")}>
                                  <UiIcon name="plus" size={12} />
                                  <span>Add</span>
                                </button>
                              </div>
                              <KvTable
                                rows={activeTab.request.body.urlencoded}
                                onChange={(idx, p) => {
                                  const next = [...activeTab.request.body.urlencoded];
                                  next[idx] = { ...next[idx], ...p } as KvRow;
                                  patchActiveBody({ urlencoded: next });
                                }}
                                onRemove={(idx) => {
                                  const next = activeTab.request.body.urlencoded.filter((_, i) => i !== idx);
                                  patchActiveBody({ urlencoded: next });
                                }}
                              />
                            </>
                          )}

                          {activeTab.request.body.mode === "graphql" && (
                            <div className={styles.graphqlPanel}>
                              <div className={styles.scriptSectionHeader}>
                                <span>GraphQL Query</span>
                              </div>
                              <textarea
                                className={styles.codeArea}
                                value={activeTab.request.body.graphqlQuery}
                                onChange={(e) =>
                                  patchActiveBody({
                                    graphqlQuery: e.target.value,
                                  })
                                }
                                spellCheck={false}
                              />
                              <div className={styles.scriptSectionHeader}>
                                <span>GraphQL Variables (JSON)</span>
                              </div>
                              <textarea
                                className={styles.codeArea}
                                value={activeTab.request.body.graphqlVars}
                                onChange={(e) =>
                                  patchActiveBody({
                                    graphqlVars: e.target.value,
                                  })
                                }
                                spellCheck={false}
                              />
                            </div>
                          )}

                          {activeTab.request.body.mode === "binary" && (
                            <div className={styles.emptyHint}>
                              Binary file streaming is not supported in browser runtime.
                            </div>
                          )}

                          {activeTab.request.body.mode === "none" && (
                            <div className={styles.emptyHint}>This request does not have a body.</div>
                          )}
                        </>
                      )}

                      {state.activeConfigTab === "scripts" && (
                        <div className={styles.scriptsPanel}>
                          <div className={styles.scriptSectionHeader}>
                            <span>Pre-request Script (JavaScript)</span>
                            <button type="button" className={styles.btn} onClick={runPreScript}>
                              <UiIcon name="play" size={11} />
                              <span>Run</span>
                            </button>
                          </div>
                          <textarea
                            className={styles.codeArea}
                            value={activeTab.request.scripts.preRequest}
                            onChange={(e) =>
                              patchActiveRequest("scripts", {
                                ...activeTab.request.scripts,
                                preRequest: e.target.value,
                              })
                            }
                            spellCheck={false}
                          />
                          <div className={styles.scriptSectionHeader}>
                            <span>Post-response Tests (`pm.test`)</span>
                          </div>
                          <textarea
                            className={styles.codeArea}
                            value={activeTab.request.scripts.postResponse}
                            onChange={(e) =>
                              patchActiveRequest("scripts", {
                                ...activeTab.request.scripts,
                                postResponse: e.target.value,
                              })
                            }
                            spellCheck={false}
                          />
                        </div>
                      )}

                      {state.activeConfigTab === "settings" && (
                        <div className={styles.settingsPanel}>
                          <label className={styles.fieldRow}>
                            <span>Request Timeout (ms)</span>
                            <Input
                              type="number"
                              value={activeTab.request.settings.timeout}
                              onChange={(e) =>
                                patchActiveRequest("settings", {
                                  ...activeTab.request.settings,
                                  timeout: Number(e.target.value) || 15000,
                                })
                              }
                            />
                          </label>
                          <label className={styles.fieldRow}>
                            <span>Follow Redirects</span>
                            <Input
                              type="checkbox"
                              checked={activeTab.request.settings.followRedirects}
                              onChange={(e) =>
                                patchActiveRequest("settings", {
                                  ...activeTab.request.settings,
                                  followRedirects: e.target.checked,
                                })
                              }
                            />
                          </label>
                          <label className={styles.fieldRow}>
                            <span>Disable Cache</span>
                            <Input
                              type="checkbox"
                              checked={activeTab.request.settings.disableCache}
                              onChange={(e) =>
                                patchActiveRequest("settings", {
                                  ...activeTab.request.settings,
                                  disableCache: e.target.checked,
                                })
                              }
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                </SplitPanel>

                <SplitHandle />

                {/* Response Viewer Panel */}
                <SplitPanel minSize="140px">
                  <div className={styles.responsePane}>
                    <div className={styles.responseHeader}>
                      <div className={styles.responseTitleGroup}>
                        <span className={styles.paneHeading}>Response</span>
                        <div className={styles.responseMeta}>
                          {activeTab.sending && <span>Executing request...</span>}
                          {!activeTab.sending && activeTab.error && (
                            <span className={styles.errorText}>{activeTab.error}</span>
                          )}
                          {!activeTab.sending && !activeTab.error && resp && (
                            <>
                              <span
                                className={`${styles.statusPill} ${
                                  resp.status >= 400
                                    ? styles.statusError
                                    : resp.status >= 300
                                      ? styles.statusWarning
                                      : styles.statusSuccess
                                }`}
                              >
                                {resp.status} {resp.statusText}
                              </span>
                              <span className={styles.metaBadge}>
                                <span>Time:</span>
                                <span className={styles.metaVal}>{resp.timeMs} ms</span>
                              </span>
                              <span className={styles.metaBadge}>
                                <span>Size:</span>
                                <span className={styles.metaVal}>{formatBytes(resp.sizeBytes)}</span>
                              </span>
                            </>
                          )}
                          {!activeTab.sending && !activeTab.error && !resp && <span>Click Send to get a response</span>}
                        </div>
                      </div>

                      <div className={styles.responseTools}>
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={!resp}
                          onClick={() => {
                            if (!resp) return;
                            navigator.clipboard
                              .writeText(resp.bodyText)
                              .then(() => {
                                setCopiedResponse(true);
                                window.setTimeout(() => setCopiedResponse(false), 1400);
                              })
                              .catch(() => {});
                          }}
                        >
                          <UiIcon name={copiedResponse ? "check" : "copy"} size={12} />
                          <span>Copy</span>
                        </button>
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={!resp}
                          onClick={() => {
                            if (!resp) return;
                            const blob = new Blob([resp.bodyText], {
                              type: "text/plain",
                            });
                            const a = document.createElement("a");
                            a.href = URL.createObjectURL(blob);
                            a.download = "response.txt";
                            a.click();
                            URL.revokeObjectURL(a.href);
                          }}
                        >
                          <UiIcon name="download" size={12} />
                          <span>Save</span>
                        </button>
                      </div>
                    </div>

                    <div className={styles.responseSubtoolbar}>
                      <div className={styles.responseSubLeft}>
                        <div className={styles.segGroup}>
                          {resTabs.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              className={`${styles.segBtn} ${state.activeResTab === t.id ? styles.segBtnActive : ""}`}
                              onClick={() =>
                                patchState((prev) => ({
                                  ...prev,
                                  activeResTab: t.id,
                                }))
                              }
                            >
                              {t.id === "headers"
                                ? `Headers${resp ? ` (${resp.headers.length})` : ""}`
                                : t.id === "tests"
                                  ? `Tests${activeTab.testResults.length ? ` (${activeTab.testResults.length})` : ""}`
                                  : t.id === "cookies"
                                    ? `Cookies${resp ? ` (${resp.cookies.length})` : ""}`
                                    : t.label}
                            </button>
                          ))}
                        </div>
                        <div className={styles.segGroup}>
                          <button
                            type="button"
                            className={`${styles.segBtn} ${state.resViewMode === "pretty" ? styles.segBtnActive : ""}`}
                            onClick={() =>
                              patchState((prev) => ({
                                ...prev,
                                resViewMode: "pretty",
                              }))
                            }
                          >
                            Pretty
                          </button>
                          <button
                            type="button"
                            className={`${styles.segBtn} ${state.resViewMode === "raw" ? styles.segBtnActive : ""}`}
                            onClick={() =>
                              patchState((prev) => ({
                                ...prev,
                                resViewMode: "raw",
                              }))
                            }
                          >
                            Raw
                          </button>
                        </div>
                      </div>

                      <div className={styles.responseSubRight}>
                        <div className={styles.searchBox}>
                          <UiIcon name="search" size={12} className={styles.searchIcon} />
                          <Input
                            className={styles.searchInput}
                            value={responseSearch}
                            onChange={(e) => setResponseSearch(e.target.value)}
                            placeholder="Filter response..."
                          />
                        </div>
                      </div>
                    </div>

                    <div className={styles.responseBody}>
                      {state.activeResTab === "body" && (
                        <>
                          {!resp && !activeTab.error && (
                            <div className={styles.emptyState}>
                              <div className={styles.emptyStateIcon}>
                                <UiIcon name="send" size={16} />
                              </div>
                              <span className={styles.emptyStateTitle}>Ready to send request</span>
                              <span>Click Send to get a response</span>
                            </div>
                          )}
                          {activeTab.error && (
                            <div className={styles.emptyState}>
                              <div className={styles.emptyStateIcon}>
                                <UiIcon name="alert" size={16} />
                              </div>
                              <span className={styles.errorText}>{activeTab.error}</span>
                            </div>
                          )}
                          {resp && (
                            <div className={styles.codeViewerWrap}>
                              <div className={styles.lineNumbers} aria-hidden="true">
                                {Array.from({ length: responseLineCount }, (_, i) => (
                                  <div key={i}>{i + 1}</div>
                                ))}
                              </div>
                              <pre
                                className={styles.jsonViewer}
                                dangerouslySetInnerHTML={{
                                  __html: resp?.isJson
                                    ? colorizeJson(formattedResponseText)
                                    : respIsHtml
                                      ? colorizeHtml(formattedResponseText)
                                      : escapeHtml(formattedResponseText),
                                }}
                              />
                            </div>
                          )}
                        </>
                      )}

                      {state.activeResTab === "headers" && resp && (
                        <table className={styles.kvTable}>
                          <thead>
                            <tr>
                              <th style={{ width: "38%" }}>Header Name</th>
                              <th>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {resp.headers
                              .filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(responseSearch.toLowerCase()))
                              .map(([k, v], i) => (
                                <tr key={i}>
                                  <td
                                    style={{
                                      fontFamily: "var(--font-mono-code)",
                                      fontWeight: 600,
                                    }}
                                  >
                                    {k}
                                  </td>
                                  <td
                                    style={{
                                      fontFamily: "var(--font-mono-code)",
                                    }}
                                  >
                                    {v}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      )}

                      {state.activeResTab === "cookies" && resp && (
                        <table className={styles.kvTable}>
                          <tbody>
                            {resp.cookies.length === 0 && (
                              <tr>
                                <td className={styles.emptyHint}>No cookies returned by the server.</td>
                              </tr>
                            )}
                            {resp.cookies.map(([k, v], i) => (
                              <tr key={i}>
                                <th style={{ width: "40%" }}>{k}</th>
                                <td>{v}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {state.activeResTab === "tests" && (
                        <div className={styles.testsList}>
                          {activeTab.testResults.length === 0 && (
                            <div className={styles.emptyHint}>No test results recorded for this request.</div>
                          )}
                          {activeTab.testResults.map((t, i) => (
                            <div key={i} className={styles.testRow}>
                              <span className={t.passed ? styles.testPassBadge : styles.testFailBadge}>
                                {t.passed ? "PASS" : "FAIL"}
                              </span>
                              <div>
                                <div style={{ fontWeight: 500 }}>{t.name}</div>
                                {!t.passed && t.error && <div className={styles.testError}>{t.error}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </SplitPanel>
              </SplitGroup>
            </>
          )}

          {!activeTab && <div className={styles.emptyState}>No request tab open.</div>}

          {/* Bottom Console Status Bar & Drawer */}
          <div className={styles.consoleBar}>
            <div className={styles.consoleBarLeft}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSubtle}`}
                onClick={() => setConsoleOpen((s) => !s)}
              >
                <UiIcon name="terminal" size={12} />
                <span>Console ({state.consoleLogs.length})</span>
              </button>
              {consoleOpen && state.consoleLogs.length > 0 && (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSubtle}`}
                  onClick={() => patchState((prev) => ({ ...prev, consoleLogs: [] }))}
                >
                  Clear
                </button>
              )}
            </div>
            <div className={styles.consoleBarRight}>
              <span style={{ color: "var(--muted-foreground)" }}>
                Env: <strong style={{ color: "var(--foreground)" }}>{activeEnv?.name ?? "None"}</strong>
              </span>
            </div>
          </div>

          {consoleOpen && (
            <div className={styles.consoleDrawer}>
              {state.consoleLogs.length === 0 && <div className={styles.emptyHint}>No console logs recorded.</div>}
              {state.consoleLogs.map((log) => (
                <div key={log.id} className={`${styles.logLine} ${styles[`log_${log.level}`]}`}>
                  <span className={styles.logTime}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {/* cURL Export Modal */}
      {curlOpen && (
        <div className={styles.modalBackdrop} onClick={() => setCurlOpen(false)}>
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span>cURL Command</span>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setCurlOpen(false)}
                aria-label="Close modal"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
            <pre className={styles.codeArea}>{curlText}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function KvTable({
  rows,
  onChange,
  onRemove,
}: {
  rows: KvRow[];
  onChange: (index: number, patch: Partial<KvRow>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className={styles.kvWrapper}>
      <table className={styles.kvTable}>
        <thead>
          <tr>
            <th style={{ width: 34, textAlign: "center" }} title="Toggle this row on/off">
              On
            </th>
            <th style={{ width: "30%" }}>Key</th>
            <th style={{ width: "34%" }}>Value</th>
            <th>Description</th>
            <th style={{ width: 34, textAlign: "center" }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx} className={!row.enabled ? styles.kvRowDisabled : undefined}>
              <td style={{ textAlign: "center" }}>
                <Checkbox
                  checked={row.enabled}
                  className={styles.kvCheck}
                  aria-label={row.enabled ? "Disable row" : "Enable row"}
                  onChange={(checked) => onChange(idx, { enabled: checked })}
                />
              </td>
              <td>
                <Input
                  className={styles.kvInput}
                  variant="bare"
                  value={row.key}
                  placeholder="Key"
                  onChange={(e) => onChange(idx, { key: e.target.value })}
                />
              </td>
              <td>
                <Input
                  className={styles.kvInput}
                  variant="bare"
                  value={row.value}
                  placeholder="Value"
                  onChange={(e) => onChange(idx, { value: e.target.value })}
                />
              </td>
              <td>
                <Input
                  className={styles.kvInput}
                  variant="bare"
                  value={row.description}
                  placeholder="Description"
                  onChange={(e) => onChange(idx, { description: e.target.value })}
                />
              </td>
              <td style={{ textAlign: "center" }}>
                <button
                  type="button"
                  title="Delete Row"
                  aria-label="Delete Row"
                  className={`${styles.iconBtn} ${styles.iconBtnDestructive}`}
                  onClick={() => onRemove(idx)}
                >
                  <Icon name="close" size={12} />
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className={styles.emptyHint}>
                No rows configured. Click + Add to insert a parameter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const restHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--syn-property)" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.bool, color: "var(--syn-keyword)" },
  { tag: tags.null, color: "var(--syn-keyword)" },
  { tag: tags.punctuation, color: "var(--syn-punct)" },
  { tag: tags.bracket, color: "var(--syn-punct)" },
  { tag: tags.comment, color: "var(--syn-comment)" },
]);

function bodyLangExtension(lang: string) {
  if (lang === "json" || lang === "javascript") return javascript();
  if (lang === "html" || lang === "xml") return html();
  return [];
}

function BodyCodeEditor({ lang, value, onChange }: { lang: string; value: string; onChange: (value: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        bodyLangExtension(lang),
        syntaxHighlighting(restHighlightStyle, { fallback: false }),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "12px",
            fontFamily: "var(--font-mono-code)",
            color: "var(--foreground)",
            backgroundColor: "transparent",
          },
          ".cm-content": {
            padding: "12px 14px",
            lineHeight: "1.55",
          },
          ".cm-focused": { outline: "none" },
          ".cm-gutters": { display: "none" },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [lang]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return <div ref={containerRef} className={`${styles.codeArea} ${styles.codeAreaFlush}`} />;
}

function VariableUrlInput({
  value,
  env,
  onChange,
  onKeyDown,
}: {
  value: string;
  env: Environment | null;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState<{
    name: string;
    found: boolean;
    text: string;
    left: number;
  } | null>(null);
  const vars = useMemo(() => envVariablesMap(env), [env]);

  const tokenRanges = useMemo(() => {
    const ranges: { start: number; end: number; name: string }[] = [];
    const re = /\{\{([^}]+)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        name: (match[1] ?? "").trim(),
      });
    }
    return ranges;
  }, [value]);

  const backdropHtml = useMemo(() => {
    let last = 0;
    const parts: string[] = [];
    for (const range of tokenRanges) {
      if (range.start > last) parts.push(escapeHtml(value.slice(last, range.start)));
      const found = Object.prototype.hasOwnProperty.call(vars, range.name);
      const color = found ? "var(--accent)" : "var(--danger)";
      parts.push(
        `<span style="color:${color};font-weight:600">${escapeHtml(value.slice(range.start, range.end))}</span>`,
      );
      last = range.end;
    }
    parts.push(escapeHtml(value.slice(last)));
    return parts.join("");
  }, [value, tokenRanges, vars]);

  function tokenAt(offset: number) {
    return tokenRanges.find((r) => offset >= r.start && offset < r.end) ?? null;
  }

  function handleMouseMove(e: React.MouseEvent<HTMLInputElement>) {
    const input = inputRef.current;
    const container = containerRef.current;
    if (!input || !container) return;
    const rect = input.getBoundingClientRect();
    const style = window.getComputedStyle(input);
    const canvas =
      (handleMouseMove as unknown as { canvas?: HTMLCanvasElement }).canvas ||
      (handleMouseMove as unknown as { canvas: HTMLCanvasElement }).canvas ||
      document.createElement("canvas");
    (handleMouseMove as unknown as { canvas: HTMLCanvasElement }).canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.font = style.font;
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const localX = e.clientX - rect.left - padLeft + input.scrollLeft;
    let idx = 0;
    let width = 0;
    if (ctx) {
      while (idx < value.length) {
        const next = width + ctx.measureText(value[idx] ?? "").width;
        if (next > localX) break;
        width = next;
        idx += 1;
      }
    } else {
      idx = Math.max(0, Math.min(value.length, Math.floor(localX / 7.2)));
    }
    let match = tokenAt(idx);
    if (!match && idx > 0) match = tokenAt(idx - 1);
    const left = Math.min(
      Math.max(e.clientX - container.getBoundingClientRect().left, 8),
      Math.max(container.getBoundingClientRect().width - 8, 8),
    );
    if (!match) {
      setHover(null);
      return;
    }
    const found = Object.prototype.hasOwnProperty.call(vars, match.name);
    setHover({
      name: match.name,
      found,
      text: found ? `${match.name}: ${vars[match.name]}` : tx`${match.name}: not found`,
      left,
    });
  }

  function handleMouseLeave() {
    setHover(null);
  }

  return (
    <div
      ref={containerRef}
      className={styles.urlInputWrap}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className={styles.urlInputBackdrop} aria-hidden dangerouslySetInnerHTML={{ __html: backdropHtml }} />
      <input
        ref={inputRef}
        className={styles.urlInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Enter request URL or {{variable}}/endpoint"
        style={{ color: "transparent", caretColor: "var(--foreground)" }}
      />
      {hover && (
        <div className={styles.urlVarTooltip} style={{ left: hover.left }}>
          <span style={{ color: hover.found ? "var(--accent)" : "var(--danger)", fontWeight: 600 }}>{hover.text}</span>
        </div>
      )}
    </div>
  );
}
